import {
  relationKeyRefSchema,
  type createItemSchema,
  type ItemCause,
  type ItemWriteResult,
  type ParsedUpsertItem,
  type patchItemSchema,
  type Subject,
  type ValueError,
} from '@16bit/core'
import type { Transaction } from 'kysely'
import type { z } from 'zod'
import { checkHub, folderHub, itemHub } from './access.ts'
import type { Database } from './db/database.ts'
import { workspaceSeq } from './db/scope.ts'
import { HttpError } from './http.ts'
import { createItem, deleteItem, getItem, patchItem, upsertItem } from './items.ts'
import { idempotentWrite, type KnownMutation } from './mutations.ts'

// The item writes, as the single-item routes and the batch call (D65, #202) both run them:
// grant check in the write's own transaction, the write, its `seq`, and a retry with a known
// `clientMutationId` answered as its first attempt was (D59, mutations.ts). Only the batch
// resolves `{ externalKey }` references in relation values (`keyRefs`); a single-item route
// leaves them in, and validation refuses them as any other invalid value.

type Trx = Transaction<Database>

/** Runs `fn` in a new transaction in the caller's scope (row-level security). */
export type Run = <R>(fn: (trx: Trx) => Promise<R>) => Promise<R>

export interface WriteContext {
  run: Run
  workspaceId: string
  principal: Subject
  /** Resolve `{ externalKey }` elements of relation values before the write (batch only). */
  keyRefs?: boolean
}

type ParsedCreate = z.output<typeof createItemSchema>
type ParsedPatch = z.output<typeof patchItemSchema>

/** The item as it is now, after a retry found its first attempt. */
async function currentItem(
  trx: Trx,
  workspaceId: string,
  first: KnownMutation,
): Promise<ItemWriteResult> {
  const seq = await workspaceSeq(trx, workspaceId)
  return { ...(await getItem(trx, workspaceId, first.itemId)), seq }
}

const isKeyRef = (value: unknown): value is { externalKey: string } =>
  relationKeyRefSchema.safeParse(value).success

/**
 * `values` with each `{ externalKey }` element of a relation value replaced by the ID of the
 * item that holds the key (D65), looked up in `hubId`, the writing item's hub, as the caller
 * sees it: an item an earlier operation of the batch created has committed and is found. The
 * relation must target that hub (#250): a cross-hub relation takes item IDs only. A reference
 * on an attribute that is not a relation is left for validation to refuse. A missing key, or a
 * relation into another hub, is a 422 `invalid_values` naming the attribute.
 */
export async function resolveKeyRefs(
  trx: Trx,
  workspaceId: string,
  hubId: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const referencing = Object.entries(values).filter(([, v]) => Array.isArray(v) && v.some(isKeyRef))
  if (referencing.length === 0) return values
  const attributes = await trx
    .selectFrom('attribute')
    .select(['id', 'type', 'config'])
    .where('workspace_id', '=', workspaceId)
    .where(
      'id',
      'in',
      referencing.map(([id]) => id),
    )
    .execute()
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const errors: ValueError[] = []
  const out = { ...values }
  for (const [attributeId, value] of referencing) {
    const attribute = byId.get(attributeId)
    if (attribute?.type !== 'relation') continue
    if (attribute.config['targetHubId'] !== hubId) {
      errors.push({
        attributeId,
        code: 'invalid_value',
        message: 'References by externalKey work only in a relation to the item’s own hub',
      })
      continue
    }
    // One lookup for every key this attribute names (#281).
    const elements = value as unknown[]
    const wanted = [...new Set(elements.filter(isKeyRef).map((e) => e.externalKey))]
    const holders = await trx
      .selectFrom('item')
      .select(['id', 'external_key'])
      .where('workspace_id', '=', workspaceId)
      .where('hub_id', '=', hubId)
      .where('external_key', 'in', wanted)
      .execute()
    const idByKey = new Map(holders.map((h) => [h.external_key, h.id]))
    const missing = wanted.find((key) => !idByKey.has(key))
    if (missing !== undefined) {
      errors.push({
        attributeId,
        code: 'invalid_value',
        message: `No item of this hub has the external key ${JSON.stringify(missing)}`,
      })
      continue
    }
    const resolved = elements.map((e) => (isKeyRef(e) ? idByKey.get(e.externalKey) : e))
    out[attributeId] = resolved
  }
  if (errors.length > 0) {
    throw new HttpError('invalid_values', 'Some values are not valid', { errors })
  }
  return out
}

const withRefs = async <V extends { values: Record<string, unknown> }>(
  ctx: WriteContext,
  trx: Trx,
  hubId: string,
  input: V,
): Promise<V> =>
  ctx.keyRefs
    ? { ...input, values: await resolveKeyRefs(trx, ctx.workspaceId, hubId, input.values) }
    : input

/** `POST /items` (201). */
export function createWrite(ctx: WriteContext, body: ParsedCreate): Promise<ItemWriteResult> {
  const { workspaceId, principal } = ctx
  return idempotentWrite(
    ctx.run,
    { workspaceId, actor: principal.id, clientMutationId: body.clientMutationId },
    { op: 'create', itemId: body.id, folderId: body.folderId },
    async (trx): Promise<ItemWriteResult> => {
      const hubId = await folderHub(trx, workspaceId, body.folderId)
      await checkHub(trx, workspaceId, principal, hubId, 'item.write', 'Folder')
      const input = await withRefs(ctx, trx, hubId, body)
      const created = await createItem(trx, workspaceId, principal.id, input)
      return { ...created, seq: await workspaceSeq(trx, workspaceId) }
    },
    (trx, first) => currentItem(trx, workspaceId, first),
  )
}

/** `PATCH /items/:itemId` (200). */
export function patchWrite(
  ctx: WriteContext,
  itemId: string,
  body: ParsedPatch,
): Promise<ItemWriteResult> {
  const { workspaceId, principal } = ctx
  return idempotentWrite(
    ctx.run,
    { workspaceId, actor: principal.id, clientMutationId: body.clientMutationId },
    { op: 'update', itemId },
    async (trx): Promise<ItemWriteResult> => {
      const hubId = await itemHub(trx, workspaceId, itemId)
      await checkHub(trx, workspaceId, principal, hubId, 'item.write', 'Item')
      const input = await withRefs(ctx, trx, hubId, body)
      const patched = await patchItem(trx, workspaceId, principal.id, itemId, input)
      return { ...patched, seq: await workspaceSeq(trx, workspaceId) }
    },
    (trx, first) => currentItem(trx, workspaceId, first),
  )
}

/**
 * `DELETE /items/:itemId` (204). Answers the delete revision's `seq`, which the route drops and
 * the batch returns; a retry answers the first attempt's (D65).
 */
export function deleteWrite(
  ctx: WriteContext,
  itemId: string,
  input: { version: number; clientMutationId?: string | undefined; cause?: ItemCause | undefined },
): Promise<{ seq: number }> {
  const { workspaceId, principal } = ctx
  const { version, clientMutationId, cause } = input
  return idempotentWrite(
    ctx.run,
    { workspaceId, actor: principal.id, clientMutationId },
    { op: 'delete', itemId },
    async (trx) => {
      const hubId = await itemHub(trx, workspaceId, itemId)
      await checkHub(trx, workspaceId, principal, hubId, 'item.write', 'Item')
      await deleteItem(trx, workspaceId, principal.id, itemId, version, clientMutationId, cause)
      return { seq: await workspaceSeq(trx, workspaceId) }
    },
    (_trx, first) => Promise.resolve({ seq: first.seq }),
  )
}

/**
 * `PUT /hubs/:hubId/items/by-key/:key`: creates (`created`, 201) or patches (200). The caller
 * reruns it on a key race (`rerunOnKeyRace`).
 */
export function upsertWrite(
  ctx: WriteContext,
  hubId: string,
  key: string,
  body: ParsedUpsertItem,
): Promise<{ created: boolean; result: ItemWriteResult }> {
  const { workspaceId, principal } = ctx
  return idempotentWrite(
    ctx.run,
    { workspaceId, actor: principal.id, clientMutationId: body.clientMutationId },
    { op: 'upsert', hubId, externalKey: key, folderId: body.folderId },
    async (trx) => {
      await checkHub(trx, workspaceId, principal, hubId, 'item.write', 'Hub')
      const input = await withRefs(ctx, trx, hubId, body)
      const { item, created } = await upsertItem(trx, workspaceId, principal.id, hubId, key, input)
      const result: ItemWriteResult = { ...item, seq: await workspaceSeq(trx, workspaceId) }
      return { created, result }
    },
    async (trx, first) => ({
      created: first.op === 'create',
      result: await currentItem(trx, workspaceId, first),
    }),
  )
}
