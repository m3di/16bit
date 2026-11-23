import {
  REVISION_OPS,
  revisionPatchSchema,
  type Page,
  type RevisionEntry,
  type Subject,
} from '@16bit/core'
import type { Transaction } from 'kysely'
import { z } from 'zod'
import { checkHub } from './access.ts'
import type { Database } from './db/database.ts'
import { decodeCursor, encodeCursor } from './http.ts'
import { getItem } from './items.ts'

// An item's history (D9, D63): `GET /items/:itemId/revisions`. Newest first, by version, which
// orders an item's revisions as `seq` does (a write holds the item row while it takes both).
// Each page is a range scan on the unique (workspace_id, item_id, version) index from 0001.

/** The last entry's version. */
const versionCursorSchema = z.tuple([z.int().min(1)])

/**
 * One page of the item's revisions, newest first. It answers 404 exactly where
 * `GET /items/:itemId` does: the item must exist and its hub must be readable, so a deleted
 * item's history is not readable (M3). Run in the caller's scope.
 */
export async function itemRevisions(
  trx: Transaction<Database>,
  workspaceId: string,
  principal: Subject,
  itemId: string,
  page: { limit: number; cursor?: string | undefined },
): Promise<Page<RevisionEntry>> {
  const item = await getItem(trx, workspaceId, itemId)
  await checkHub(trx, workspaceId, principal, item.hubId, 'hub.read', 'Item')
  const before = page.cursor ? decodeCursor(versionCursorSchema, page.cursor)[0] : null

  let q = trx
    .selectFrom('revision')
    .select(['seq', 'version', 'patch', 'actor', 'at', 'cause'])
    .where('workspace_id', '=', workspaceId)
    .where('item_id', '=', itemId)
  if (before !== null) q = q.where('version', '<', before)
  const rows = await q
    .orderBy('version', 'desc')
    .limit(page.limit + 1)
    .execute()

  const entries = rows.slice(0, page.limit).map((row): RevisionEntry => {
    const base = {
      seq: row.seq,
      version: row.version,
      actor: row.actor,
      at: row.at.toISOString(),
      cause: row.cause,
    }
    // Written by the API only, in this shape; parsed so the wire type is checked, not cast. One
    // that no longer parses (written by an older version, say) is marked unreadable instead of
    // failing the whole page (#222).
    const parsed = revisionPatchSchema.safeParse(row.patch)
    if (parsed.success) return { ...base, op: parsed.data.op, patch: parsed.data }
    console.error(
      `revision ${String(row.seq)} of item ${itemId} in workspace ${workspaceId} has a patch ` +
        'that does not parse: ' +
        (parsed.error.issues[0]?.message ?? ''),
    )
    return { ...base, op: storedOp(row.patch, row.version), patch: null, unreadable: true }
  })
  const last = entries.at(-1)
  return {
    items: entries,
    nextCursor: rows.length > page.limit && last ? encodeCursor([last.version]) : null,
  }
}

/**
 * The operation of a patch that doesn't parse: its own `op` when that is one, else what its
 * place says (the first version is the create).
 */
function storedOp(patch: unknown, version: number): RevisionEntry['op'] {
  const op = (patch as { op?: unknown } | null)?.op
  const known: readonly unknown[] = REVISION_OPS
  if (known.includes(op)) return op as RevisionEntry['op']
  return version === 1 ? 'create' : 'update'
}
