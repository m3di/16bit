import type { Transaction } from 'kysely'
import type { Database } from './db/database.ts'
import { HttpError, notFound } from './http.ts'
import { MutationReplayed } from './items.ts'

// Safe retries of item writes (D59). A write may carry a `clientMutationId`, stored on its
// revision and unique per workspace and actor (migration 0012). A retry with a known ID writes
// nothing and answers as the first attempt did, with the item as it is now:
//
// - create and patch: 201 or 200 with the current item, or 404 if it has been deleted since,
//   as a GET of it would answer;
// - delete: 204, as the first delete did.
//
// The same ID with another item or operation is a 422 `mutation_id_reused`. A first attempt
// whose revision the caller can no longer read (the hub's grant revoked) is not found under
// row-level security; the retry then answers what a fresh write answers, which for an item in
// that hub is a 404, and a racing insert into the unique index rolls back and answers 404 too.

type Trx = Transaction<Database>

export type MutationOp = 'create' | 'update' | 'delete'

/**
 * What this attempt would write: compared with the first attempt's revision. An `upsert` (D64)
 * may have created or patched, so it matches a first attempt of either op (#200): one in the hub
 * `hubId`, where a create was of the key `externalKey` into `folderId`, and the item that holds
 * the key now, if any, is the first attempt's. A patch's revision does not record the key, so
 * once no item holds it the hub is all that is compared.
 */
export type MutationAttempt =
  | {
      op: MutationOp
      /** The item, when the attempt names one (patch, delete, create with an `id`). */
      itemId?: string | undefined
      /** The folder a create goes into. */
      folderId?: string | undefined
    }
  | { op: 'upsert'; hubId: string; externalKey: string; folderId: string }

/** The first attempt with this ID, as far as the caller can still read it. */
export interface KnownMutation {
  op: MutationOp
  itemId: string
}

/**
 * The caller's revision with `clientMutationId`, or null if there is none it can read. A 422 if
 * that revision was for another item or operation than `attempt`.
 */
export async function findMutation(
  trx: Trx,
  workspaceId: string,
  actor: string,
  clientMutationId: string,
  attempt: MutationAttempt,
): Promise<KnownMutation | null> {
  const row = await trx
    .selectFrom('revision')
    .select(['item_id', 'hub_id', 'patch'])
    .where('workspace_id', '=', workspaceId)
    .where('actor', '=', actor)
    .where('client_mutation_id', '=', clientMutationId)
    .executeTakeFirst()
  if (!row) return null
  const op = row.patch['op'] as MutationOp
  const same =
    attempt.op === 'upsert'
      ? await sameUpsert(trx, workspaceId, attempt, { ...row, op })
      : op === attempt.op &&
        (attempt.itemId === undefined || attempt.itemId === row.item_id) &&
        (attempt.folderId === undefined || attempt.folderId === row.patch['folderId'])
  if (!same) {
    throw new HttpError(
      'mutation_id_reused',
      'This clientMutationId was already used for another item or operation',
    )
  }
  return { op, itemId: row.item_id }
}

/** Whether an upsert's first attempt is the revision `first` (see `MutationAttempt`). */
async function sameUpsert(
  trx: Trx,
  workspaceId: string,
  attempt: Extract<MutationAttempt, { op: 'upsert' }>,
  first: { op: MutationOp; item_id: string; hub_id: string; patch: Record<string, unknown> },
): Promise<boolean> {
  if (first.hub_id !== attempt.hubId) return false
  if (first.op === 'delete') return false
  if (
    first.op === 'create' &&
    (first.patch['externalKey'] !== attempt.externalKey ||
      first.patch['folderId'] !== attempt.folderId)
  ) {
    return false
  }
  const holder = await trx
    .selectFrom('item')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', attempt.hubId)
    .where('external_key', '=', attempt.externalKey)
    .executeTakeFirst()
  return holder === undefined || holder.id === first.item_id
}

/** The unique index on a revision's mutation ID (migration 0012). */
const MUTATION_KEY = 'revision_client_mutation_key'

/**
 * The failures of a write that may mean its first attempt committed while it waited, so the ID
 * is worth a second lookup: the index refused the revision, or the item it locked had moved
 * (409 `conflict`), was gone (404) or was taken by the first create (409 `id_taken`). Anything
 * else, a 403 or a 422 among them, is the answer as it stands.
 */
function mayBeFirstAttempt(error: unknown): boolean {
  if (error instanceof MutationReplayed) return true
  if ((error as { constraint?: unknown } | null)?.constraint === MUTATION_KEY) return true
  return (
    error instanceof HttpError &&
    (error.code === 'conflict' ||
      error.code === 'not_found' ||
      error.code === 'id_taken' ||
      error.code === 'precondition_failed')
  )
}

/**
 * Runs an item write with `clientMutationId` safely (D59). `run` opens a request-scoped
 * transaction. `write` is the write itself; `answer` answers a retry from the first attempt's
 * revision, writing nothing.
 *
 * A known ID is answered before anything is written. When the write fails, its transaction has
 * rolled back, and the ID is looked up again in a new one: a retry that raced its first attempt
 * either waited on the unique index (`MutationReplayed`) or on the item row and then found it
 * changed (409) or gone (404), and the first attempt's answer replaces that error.
 */
export async function idempotentWrite<T>(
  run: <R>(fn: (trx: Trx) => Promise<R>) => Promise<R>,
  key: { workspaceId: string; actor: string; clientMutationId: string | undefined },
  attempt: MutationAttempt,
  write: (trx: Trx) => Promise<T>,
  answer: (trx: Trx, first: KnownMutation) => Promise<T>,
): Promise<T> {
  const { workspaceId, actor, clientMutationId } = key
  if (clientMutationId === undefined) return run(write)
  const known = (trx: Trx) => findMutation(trx, workspaceId, actor, clientMutationId, attempt)
  try {
    return await run(async (trx) => {
      const first = await known(trx)
      return first ? answer(trx, first) : write(trx)
    })
  } catch (error) {
    if (!mayBeFirstAttempt(error)) throw error
    const replayed = await run(async (trx) => {
      const first = await known(trx)
      return first ? { value: await answer(trx, first) } : null
    })
    if (replayed) return replayed.value
    // The first attempt's revision is in a hub the caller can no longer read.
    if (error instanceof MutationReplayed) throw notFound('Item')
    throw error
  }
}
