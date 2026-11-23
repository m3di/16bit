import {
  can,
  checkViewTree,
  defaultViewTree,
  deleteViewQuerySchema,
  idSchema,
  MAX_VIEW_BYTES,
  parseViewTree,
  putViewSchema,
  walkBlocks,
  type Attribute,
  type Subject,
  type View,
  type ViewSchemaContext,
  type ViewTree,
} from '@16bit/core'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import { checkHub, ownGrant } from './access.ts'
import type { Database } from './db/database.ts'
import { withScope, workspaceSeq } from './db/scope.ts'
import { enforce, HttpError, notFound, parse, schemaConflict, sqlState } from './http.ts'
import { folderDefinitions } from './items.ts'
import { notifyHub } from './notify.ts'
import { lockHubSchema } from './schema-lock.ts'

// Root views (M4-03, D76 to D79): `GET`, `PUT` and `DELETE /v1/workspaces/:w/folders/:folderId/view`.
// Contracts in packages/core/src/views.ts. One row per folder in `view` (0016), the whole tree
// replaced on every write with an expected version, and no history.
//
// Lock order, next to schema-writes.ts (whose steps these follow):
//   1. the caller's grant on the hub FOR SHARE, so a revoke waits for the write;
//   2. the hub's schema lock, shared, before the tree is checked against the attributes, so an
//      attribute delete or option removal can't commit between the check and the write (D55,
//      D79). Folder deletes don't take it: a binding to a folder deleted meanwhile stays stored
//      and its block answers `invalid` in view data (D79);
//   3. the view row (insert or update). The insert's foreign key takes the folder row FOR KEY
//      SHARE, which a folder delete's own FOR NO KEY UPDATE doesn't wait for: the delete then
//      waits for this write at its DELETE and folder_view_check refuses it (409 `has_view`),
//      or it committed first and the insert fails its foreign key (404).

type Db = Kysely<Database>
type Trx = Transaction<Database>

/**
 * JSON nesting a sent tree may reach before `parseViewTree` reads it. A valid tree nests far
 * less (8 block levels at 2 each, plus a config with a 3-level filter), but core's size and NUL
 * scans recurse, so a body nested thousands deep would overflow the stack (500) instead of
 * answering 422.
 */
export const MAX_VIEW_JSON_DEPTH = 64

/** True if `value` nests arrays and objects more than `max` deep. Iterative, so it can't overflow. */
export function jsonDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number]
    if (typeof v !== 'object' || v === null) continue
    if (depth + 1 > max) return true
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1])
  }
  return false
}

export type ViewValidation =
  { ok: true; tree: ViewTree } | { ok: false; errors: { path: string; message: string }[] }

/**
 * Everything PUT checks about a tree, for the routes and for seeds (M4-06), so a seed can never
 * store a tree PUT would refuse: nesting, then `parseViewTree` (shape, structure, caps, size, NUL),
 * then `checkViewTree` against the folders the tree binds to in `hubId` and the attributes they
 * show. A route calls it holding the hub's schema lock shared; `db` reads as its caller, so a
 * folder the caller can't see is not a folder of the hub. The returned tree is the form to store.
 */
export async function validateViewTree(
  db: Db,
  workspaceId: string,
  hubId: string,
  raw: unknown,
): Promise<ViewValidation> {
  if (jsonDeeperThan(raw, MAX_VIEW_JSON_DEPTH)) {
    return {
      ok: false,
      errors: [{ path: '', message: `A view nests at most ${String(MAX_VIEW_JSON_DEPTH)} levels` }],
    }
  }
  const parsed = parseViewTree(raw)
  if (!parsed.ok) return parsed
  const errors = checkViewTree(parsed.tree, await viewContext(db, workspaceId, hubId, parsed.tree))
  if (errors.length > 0) {
    return { ok: false, errors: errors.map(({ path, message }) => ({ path, message })) }
  }
  return { ok: true, tree: parsed.tree }
}

/**
 * The folders of `hubId` that `tree` binds to, with the attributes each shows. At most one per
 * data block (`MAX_VIEW_DATA_BLOCKS`), so this stays bounded. Folders of other hubs, and folders
 * the caller can't see, are left out, which `checkViewTree` reports.
 */
async function viewContext(
  db: Db,
  workspaceId: string,
  hubId: string,
  tree: ViewTree,
): Promise<ViewSchemaContext> {
  const ids = new Set<string>()
  for (const { block } of walkBlocks(tree.root)) {
    const binding = (block.config as { binding?: { folderId?: unknown } }).binding
    if (typeof binding?.folderId === 'string') ids.add(binding.folderId)
  }
  const folders = new Map<string, { viewsOnly: boolean; attributes: readonly Attribute[] }>()
  if (ids.size === 0) return { folders }
  const rows = await db
    .selectFrom('folder')
    .select(['id', 'views_only'])
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where('id', 'in', [...ids])
    .execute()
  for (const row of rows) {
    const attributes = row.views_only
      ? []
      : (await folderDefinitions(db, workspaceId, row.id)).map((d) => d.attribute)
    folders.set(row.id, { viewsOnly: row.views_only, attributes })
  }
  return { folders }
}

interface FolderRef {
  id: string
  hub_id: string
  views_only: boolean
}

/** The folder, or 404 when it is missing or the caller can't see it. */
async function folderRef(db: Db, workspaceId: string, folderId: string): Promise<FolderRef> {
  const row = await db
    .selectFrom('folder')
    .select(['id', 'hub_id', 'views_only'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', folderId)
    .executeTakeFirst()
  if (!row) throw notFound('Folder')
  return row
}

/** The folder's stored view, or its default (D76), without `seq`. */
async function readView(
  db: Db,
  workspaceId: string,
  folder: FolderRef,
): Promise<Omit<View, 'seq'>> {
  const row = await db
    .selectFrom('view')
    .select(['tree', 'version', 'updated_at', 'updated_by'])
    .where('workspace_id', '=', workspaceId)
    .where('folder_id', '=', folder.id)
    .executeTakeFirst()
  const base = { folderId: folder.id, hubId: folder.hub_id }
  if (!row) {
    return {
      ...base,
      stored: false,
      version: 0,
      tree: defaultViewTree(folder.id, { viewsOnly: folder.views_only }),
      updatedAt: null,
      updatedBy: null,
    }
  }
  // Every stored tree passed `parseViewTree`, which upgrades older schema versions on read. One
  // that no longer parses (a broken upgrade) must not lock readers out of the folder: it is
  // logged and the default tree is served, still at the stored row's version, so a hub admin's
  // PUT at that version replaces it and a reset removes it.
  let parsed = parseViewTree(row.tree)
  if (!parsed.ok) {
    console.error(
      `stored view of folder ${folder.id} does not parse: ${parsed.errors[0]?.message ?? ''}`,
    )
    parsed = { ok: true, tree: defaultViewTree(folder.id, { viewsOnly: folder.views_only }) }
  }
  return {
    ...base,
    stored: true,
    version: row.version,
    tree: parsed.tree,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  }
}

const current = async (trx: Trx, workspaceId: string, folder: FolderRef): Promise<View> => ({
  ...(await readView(trx, workspaceId, folder)),
  seq: await workspaceSeq(trx, workspaceId),
})

const viewConflict = (view: View) => schemaConflict('view', view)

const invalidView = (errors: { path: string; message: string }[]) =>
  new HttpError('invalid_view', 'The view is not valid', { errors })

/** `hub.manageSchema` (D78), holding the grant FOR SHARE until commit. Agents never pass. */
async function requireManage(trx: Trx, workspaceId: string, me: Subject, hubId: string) {
  const hubGrant = await ownGrant(trx, workspaceId, hubId, me.id, 'share')
  enforce(can(me, 'hub.manageSchema', { hubGrant }), 'Folder')
}

/** `GET /folders/:folderId/view`, `hub.read`, in one snapshot with the workspace `seq` (D58). */
export async function getView(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  folderId: string,
): Promise<View> {
  const folder = await folderRef(trx, workspaceId, folderId)
  await checkHub(trx, workspaceId, me, folder.hub_id, 'hub.read', 'Folder')
  return current(trx, workspaceId, folder)
}

/**
 * `PUT /folders/:folderId/view`: replaces the whole tree at the expected version. `version: 0`
 * creates; two first PUTs racing meet at the unique key, and the loser answers 409 `conflict`.
 */
export async function putView(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  folderId: string,
  input: { version: number; tree: unknown },
): Promise<View> {
  const folder = await folderRef(trx, workspaceId, folderId)
  await requireManage(trx, workspaceId, me, folder.hub_id)
  await lockHubSchema(trx, workspaceId, folder.hub_id, 'shared')
  const checked = await validateViewTree(trx, workspaceId, folder.hub_id, input.tree)
  if (!checked.ok) throw invalidView(checked.errors)
  const tree = JSON.stringify(checked.tree)

  let written: boolean
  try {
    if (input.version === 0) {
      // A concurrent first PUT that commits first makes this one do nothing, never a 23505.
      const row = await trx
        .insertInto('view')
        .values({
          workspace_id: workspaceId,
          id: randomUUID(),
          hub_id: folder.hub_id,
          folder_id: folder.id,
          tree,
          updated_by: me.id,
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'folder_id']).doNothing())
        .returning('id')
        .executeTakeFirst()
      written = row !== undefined
    } else {
      // A concurrent write to the row makes this wait, then match no row if it moved the version.
      const row = await trx
        .updateTable('view')
        .set({
          tree,
          version: input.version + 1,
          updated_at: sql`now()`,
          updated_by: me.id,
        })
        .where('workspace_id', '=', workspaceId)
        .where('folder_id', '=', folder.id)
        .where('version', '=', input.version)
        .returning('id')
        .executeTakeFirst()
      written = row !== undefined
    }
  } catch (error) {
    const state = sqlState(error)
    // The folder was deleted after it was read above (the insert's foreign key).
    if (state === '23503') throw notFound('Folder')
    // view_tree_size, a backstop: core counts the bytes as Postgres prints `jsonb`, which can
    // differ for numbers JavaScript prints differently.
    if (state === '23514' && (error as { constraint?: unknown }).constraint === 'view_tree_size') {
      throw invalidView([
        { path: '', message: `A view is at most ${String(MAX_VIEW_BYTES / 1024)} KiB` },
      ])
    }
    throw error
  }
  if (!written) throw viewConflict(await current(trx, workspaceId, folder))
  await notifyHub(trx, workspaceId, folder.hub_id)
  return current(trx, workspaceId, folder)
}

/** `DELETE /folders/:folderId/view?version=`: back to the default view (D76). */
export async function deleteView(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  folderId: string,
  version: number,
): Promise<void> {
  const folder = await folderRef(trx, workspaceId, folderId)
  await requireManage(trx, workspaceId, me, folder.hub_id)
  const row = await trx
    .deleteFrom('view')
    .where('workspace_id', '=', workspaceId)
    .where('folder_id', '=', folder.id)
    .where('version', '=', version)
    .returning('id')
    .executeTakeFirst()
  if (!row) {
    const now = await current(trx, workspaceId, folder)
    if (!now.stored) throw notFound('View')
    throw viewConflict(now)
  }
  await notifyHub(trx, workspaceId, folder.hub_id)
}

const folderParams = z.object({ workspaceId: idSchema, folderId: idSchema })

/** Registers the view routes in the workspace scope (`/v1/workspaces/:workspaceId`). */
export function registerViewRoutes(ws: FastifyInstance, db: Db): void {
  const scope = (request: FastifyRequest) => {
    const { workspaceId, folderId } = parse(folderParams, request.params)
    return { workspaceId, folderId, scope: { workspaceId, principalId: request.principal.id } }
  }

  ws.get('/folders/:folderId/view', async (request): Promise<View> => {
    const { workspaceId, folderId, scope: s } = scope(request)
    return withScope(db, s, (trx) => getView(trx, workspaceId, request.principal, folderId), {
      snapshot: true,
    })
  })

  ws.put('/folders/:folderId/view', async (request): Promise<View> => {
    const { workspaceId, folderId, scope: s } = scope(request)
    const body = parse(putViewSchema, request.body)
    return withScope(db, s, (trx) => putView(trx, workspaceId, request.principal, folderId, body))
  })

  ws.delete('/folders/:folderId/view', async (request, reply) => {
    const { workspaceId, folderId, scope: s } = scope(request)
    const { version } = parse(deleteViewQuerySchema, request.query)
    await withScope(db, s, (trx) =>
      deleteView(trx, workspaceId, request.principal, folderId, version),
    )
    return reply.status(204).send()
  })
}
