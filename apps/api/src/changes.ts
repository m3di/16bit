import type { Change, ChangesPage } from '@16bit/core'
import type { Transaction } from 'kysely'
import type { Database } from './db/database.ts'
import { workspaceSeq } from './db/scope.ts'
import { toItem } from './mappers.ts'

// Changes after a sequence number (D58), for `GET /changes` and the feed. Read from `revision`
// under the caller's own identity, so row-level security decides which hubs show, exactly as
// for a GET, and items are shaped by the same mapper as GET.

/**
 * Most revisions one read examines, visible or not. Bounds the scan when the caller can see
 * little of a busy workspace: the high-water mark still moves past what was examined.
 */
export const MAX_CHANGES_SCAN = 10_000

export interface ChangesRead {
  /**
   * The caller. A change carries its `clientMutationId` only for the principal who wrote it:
   * the echo only stops a writer applying its own change twice (D59), and is no one else's.
   */
  principalId: string
  /** Changes after this `seq`. */
  after: number
  /** Most revisions returned, before collapsing. */
  limit: number
  /** Only these hubs (the feed's subscriptions). Absent: every hub the caller can read. */
  hubIds?: readonly string[]
  /** Lowered in tests. */
  maxScan?: number
}

/**
 * The changes after `after` that the caller may see, one per item, each as the item is now
 * (`null` when it is gone) with the `seq` of its latest revision in the page, in `seq` order,
 * that revision's cause if it has one, and its `clientMutationId` when the caller wrote it.
 *
 * `seq` is the high-water mark: the workspace counter when the page is complete, the last
 * returned revision's `seq` when `limit` cut it short, and the end of the examined range when
 * the scan cap did. Every change up to it that the caller may see is in this page or an earlier
 * one, so asking again with `after = seq` misses nothing and the caller's `after` never stalls
 * on hidden changes. `more` is true when changes are already waiting past `seq`.
 *
 * Run it in a `withScope(..., { snapshot: true })` transaction: the counter, the revisions and
 * the items then come from one snapshot, and a write holds the workspace row from taking its
 * `seq` until it commits, so no revision below the counter can still appear later.
 */
export async function readChanges(
  trx: Transaction<Database>,
  workspaceId: string,
  read: ChangesRead,
): Promise<ChangesPage> {
  return (await readChangesBatch(trx, workspaceId, read)).page
}

/**
 * `readChanges`, plus `cut`: true when more than `limit` revisions the caller may see follow
 * `after`, as opposed to the scan cap ending the page. The feed answers `resync` on it (D58).
 */
export async function readChangesBatch(
  trx: Transaction<Database>,
  workspaceId: string,
  read: ChangesRead,
): Promise<{ page: ChangesPage; cut: boolean }> {
  const counter = await workspaceSeq(trx, workspaceId)
  const { after, limit } = read
  if (after >= counter || read.hubIds?.length === 0) {
    return { page: { changes: [], seq: counter, more: false }, cut: false }
  }
  // A primary key range of at most `maxScan` rows, whatever row-level security hides in it.
  const end = Math.min(counter, after + (read.maxScan ?? MAX_CHANGES_SCAN))
  let q = trx
    .selectFrom('revision')
    .select(['seq', 'item_id', 'hub_id', 'actor', 'client_mutation_id', 'cause'])
    .where('workspace_id', '=', workspaceId)
    .where('seq', '>', after)
    .where('seq', '<=', end)
  if (read.hubIds) q = q.where('hub_id', 'in', [...new Set(read.hubIds)])
  const rows = await q
    .orderBy('seq')
    .limit(limit + 1)
    .execute()

  const cut = rows.length > limit
  const page = rows.slice(0, limit)
  const seq = cut ? (page.at(-1)?.seq ?? end) : end

  // Several revisions of one item collapse to the latest; a Map keeps first-insertion order,
  // so delete and re-add to order by each item's latest `seq`.
  const latest = new Map<string, (typeof page)[number]>()
  for (const row of page) {
    latest.delete(row.item_id)
    latest.set(row.item_id, row)
  }
  const ids = [...latest.keys()]
  const items =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('item')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('id', 'in', ids)
          .execute()
  const byId = new Map(items.map((row) => [row.id, row]))

  const changes = [...latest.values()].map((row): Change => {
    const item = byId.get(row.item_id)
    const change: Change = {
      seq: row.seq,
      hubId: row.hub_id,
      itemId: row.item_id,
      item: item ? toItem(item) : null,
    }
    if (row.client_mutation_id !== null && row.actor === read.principalId) {
      change.clientMutationId = row.client_mutation_id
    }
    // The cause is part of the revision, so everyone who sees the change sees it (D63).
    if (row.cause !== null) change.cause = row.cause
    return change
  })
  return { page: { changes, seq, more: cut || end < counter }, cut }
}
