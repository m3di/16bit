import { randomUUID } from 'node:crypto'
import {
  validateItemValues,
  type FolderAttributeDefinition,
  type Item,
  type ItemValues,
  type Page,
  type PatchItem,
} from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from './db/database.ts'
import { conflict, decodeCursor, encodeCursor, HttpError, notFound } from './http.ts'
import { toAttribute, toItem } from './mappers.ts'

type Db = Kysely<Database>
type Trx = Transaction<Database>

/**
 * What a revision's `patch` holds. `update` carries only the changed keys, with `null` for a
 * cleared value. Replaying a workspace's revisions in `seq` order rebuilds every item.
 */
export type RevisionPatch =
  | { op: 'create'; folderId: string; values: ItemValues }
  | { op: 'update'; values: ItemValues }
  | { op: 'delete' }

/** Postgres NOTIFY channel. The payload is `<workspaceId>:<seq>`, read by the M3 change feed. */
export const REVISION_CHANNEL = 'revision'

// Lock order inside write transactions, to rule out deadlocks: item row, then hub row, then
// folder row, then workspace row (for the revision seq). Patch and delete lock the existing item
// row first. Create locks the hub row (next_seq), the hub and folder rows (counts), then inserts
// the new item row and takes the workspace row. The new row is invisible to other transactions,
// so taking it after the hub and folder cannot deadlock with them.

async function appendRevision(
  trx: Trx,
  workspaceId: string,
  itemId: string,
  version: number,
  patch: RevisionPatch,
  actor: string,
): Promise<number> {
  const { seq } = await trx
    .updateTable('workspace')
    .set({ next_revision_seq: sql`next_revision_seq + 1` })
    .where('id', '=', workspaceId)
    .returning(sql<number>`next_revision_seq - 1`.as('seq'))
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('revision')
    .values({
      workspace_id: workspaceId,
      seq,
      item_id: itemId,
      version,
      patch: JSON.stringify(patch),
      actor,
    })
    .execute()
  await sql`SELECT pg_notify(${REVISION_CHANNEL}, ${`${workspaceId}:${String(seq)}`})`.execute(trx)
  return seq
}

/** Adds `delta` to the item count of the hub and, if different, of the folder. */
async function bumpCounts(
  trx: Trx,
  workspaceId: string,
  hubId: string,
  folderId: string,
  delta: number,
): Promise<void> {
  for (const id of hubId === folderId ? [hubId] : [hubId, folderId]) {
    await trx
      .updateTable('folder')
      .set({ item_count: sql`item_count + ${delta}` })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .execute()
  }
}

/** The attributes a folder shows, with its `required` flags, for `validateItemValues`. */
export async function folderDefinitions(
  db: Db,
  workspaceId: string,
  folderId: string,
): Promise<FolderAttributeDefinition[]> {
  const rows = await db
    .selectFrom('folder_attribute as fa')
    .innerJoin('attribute as a', (join) =>
      join.onRef('a.workspace_id', '=', 'fa.workspace_id').onRef('a.id', '=', 'fa.attribute_id'),
    )
    .selectAll('a')
    .select('fa.required')
    .where('fa.workspace_id', '=', workspaceId)
    .where('fa.folder_id', '=', folderId)
    .orderBy('fa.position')
    .execute()
  return rows.map(({ required, ...attribute }) => ({ attribute: toAttribute(attribute), required }))
}

function validate(
  definitions: FolderAttributeDefinition[],
  values: Record<string, unknown>,
  partial: boolean,
): ItemValues {
  const result = validateItemValues(definitions, values, { partial })
  if (!result.ok) {
    throw new HttpError('invalid_values', 'Some values are not valid', { errors: result.errors })
  }
  return result.values
}

const stripNulls = (values: ItemValues): ItemValues =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null))

export async function getItem(db: Db | Trx, workspaceId: string, id: string): Promise<Item> {
  const row = await db
    .selectFrom('item')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw notFound('Item')
  return toItem(row)
}

export async function createItem(
  db: Db,
  workspaceId: string,
  actor: string,
  input: { id?: string | undefined; folderId: string; values: Record<string, unknown> },
): Promise<Item> {
  const folder = await db
    .selectFrom('folder')
    .select(['id', 'hub_id'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', input.folderId)
    .executeTakeFirst()
  if (!folder) throw notFound('Folder')
  const values = stripNulls(
    validate(await folderDefinitions(db, workspaceId, folder.id), input.values, false),
  )
  const id = input.id ?? randomUUID()

  return db.transaction().execute(async (trx) => {
    // History outlives a deleted item, so an ID is never reused, even after a delete.
    const used = await trx
      .selectFrom('revision')
      .select('seq')
      .where('workspace_id', '=', workspaceId)
      .where('item_id', '=', id)
      .limit(1)
      .executeTakeFirst()
    if (used) throw new HttpError('id_taken', 'This item ID is already used')

    const { seq_id } = await trx
      .updateTable('folder')
      .set({ next_seq: sql`next_seq + 1` })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folder.hub_id)
      .returning(sql<number>`next_seq - 1`.as('seq_id'))
      .executeTakeFirstOrThrow()
    await bumpCounts(trx, workspaceId, folder.hub_id, folder.id, 1)

    const row = await trx
      .insertInto('item')
      .values({
        workspace_id: workspaceId,
        id,
        hub_id: folder.hub_id,
        folder_id: folder.id,
        seq_id,
        values: JSON.stringify(values),
        updated_by: actor,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) throw new HttpError('id_taken', 'This item ID is already used')

    await appendRevision(
      trx,
      workspaceId,
      id,
      row.version,
      { op: 'create', folderId: folder.id, values },
      actor,
    )
    return toItem(row)
  })
}

export async function patchItem(
  db: Db,
  workspaceId: string,
  actor: string,
  id: string,
  input: PatchItem,
): Promise<Item> {
  const before = await getItem(db, workspaceId, id)
  const patch = validate(
    await folderDefinitions(db, workspaceId, before.folderId),
    input.values,
    true,
  )
  const cleared = Object.keys(patch).filter((key) => patch[key] === null)

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('item')
      .set({
        // `null` clears a value: drop those top-level keys only. Nested nulls are data.
        values: sql`(${sql.ref('values')} || ${JSON.stringify(patch)}::jsonb) - ${cleared}::text[]`,
        version: sql`version + 1`,
        updated_at: sql`now()`,
        updated_by: actor,
      })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .where('version', '=', input.version)
      .returningAll()
      .executeTakeFirst()
    // Zero rows: the item was deleted (404) or its version moved (409 with the current item).
    if (!row) throw conflict(await getItem(trx, workspaceId, id))

    await appendRevision(trx, workspaceId, id, row.version, { op: 'update', values: patch }, actor)
    return toItem(row)
  })
}

export async function deleteItem(
  db: Db,
  workspaceId: string,
  actor: string,
  id: string,
  version: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .deleteFrom('item')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .where('version', '=', version)
      .returning(['hub_id', 'folder_id', 'version'])
      .executeTakeFirst()
    if (!row) throw conflict(await getItem(trx, workspaceId, id))

    await bumpCounts(trx, workspaceId, row.hub_id, row.folder_id, -1)
    // The delete is the item's last version, so `(item_id, version)` stays unique in the log.
    await appendRevision(trx, workspaceId, id, row.version + 1, { op: 'delete' }, actor)
  })
}

const itemCursorSchema = z.tuple([z.iso.datetime(), z.string().min(1).max(64)])

/** A folder's items, newest update first, keyset-paged on `(updated_at, id)`. */
export async function queryItems(
  db: Db,
  workspaceId: string,
  query: { from: string; limit: number; cursor: string | null },
): Promise<Page<Item>> {
  const folder = await db
    .selectFrom('folder')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', query.from)
    .executeTakeFirst()
  if (!folder) throw notFound('Folder')

  let q = db
    .selectFrom('item')
    .selectAll()
    // Microsecond text form: a JS Date would drop precision and skip or repeat rows.
    .select(
      sql<string>`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'cursor_at',
      ),
    )
    .where('workspace_id', '=', workspaceId)
    .where('folder_id', '=', folder.id)
  if (query.cursor) {
    const [at, id] = decodeCursor(itemCursorSchema, query.cursor)
    q = q.where(sql<boolean>`(updated_at, id) < (${at}::timestamptz, ${id})`)
  }
  const rows = await q
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(query.limit + 1)
    .execute()

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => toItem(row)),
    nextCursor: rows.length > query.limit && last ? encodeCursor([last.cursor_at, last.id]) : null,
  }
}
