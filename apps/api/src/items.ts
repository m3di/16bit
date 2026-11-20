import { randomUUID } from 'node:crypto'
import {
  compileItemQuery,
  decodeItemCursor,
  encodeItemCursor,
  indexEntries,
  validateItemValues,
  MAX_HIDDEN_BACKLINKS,
  MAX_LINKED_ITEMS,
  type Attribute,
  type BacklinkPage,
  type CompiledFilter,
  type CompiledSort,
  type Filter,
  type FolderAttributeDefinition,
  type Item,
  type ItemQueryResult,
  type ItemRead,
  type ItemValues,
  type LinkedItem,
  type PatchItem,
  type Subject,
  type ValueError,
} from '@16bit/core'
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely'
import { z } from 'zod'
import { allReadableHubs, loadSubject, readableHubs } from './access.ts'
import type { Database } from './db/database.ts'
import { inTransaction, isScoped } from './db/scope.ts'
import { conflict, decodeCursor, encodeCursor, HttpError, notFound } from './http.ts'
import { toAttribute, toItem } from './mappers.ts'
import { lockHubSchema } from './schema-lock.ts'

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

/** UNIQUE (workspace_id, item_id, version) on revision (0001): an item ID is never reused. */
const REVISION_VERSION_KEY = 'revision_workspace_id_item_id_version_key'

// Lock order inside write transactions, to rule out deadlocks: item rows, then hub row, then
// folder row, then workspace row (for the revision seq). Patch and delete lock the existing item
// row first. Create locks the hub row (next_seq), the hub and folder rows (counts), then inserts
// the new item row and takes the workspace row. The new row is invisible to other transactions,
// so taking it after the hub and folder cannot deadlock with them. An item's item_index and
// link rows are written while its item row is held, before the workspace row.
//
// Create and patch first take the hub's schema lock shared (schema-lock.ts), then read the
// folder's attributes, so a schema write that strips values waits for them or they see its
// result. Delete takes none: it only removes values. Schema writes and their place in this
// order are described at the top of schema-writes.ts.
//
// Relation targets are locked FOR KEY SHARE, in ID order, before the writer's link rows are
// touched and before any hub row, so a target cannot be deleted before the links commit. KEY
// SHARE does not conflict with another write's own row lock (FOR NO KEY UPDATE), only with a
// delete, and a delete takes only its own item row before the hub, folder and workspace rows.

export async function appendRevision(
  trx: Trx,
  workspaceId: string,
  hubId: string,
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
      hub_id: hubId,
      version,
      patch: JSON.stringify(patch),
      actor,
    })
    .execute()
  await sql`SELECT pg_notify(${REVISION_CHANNEL}, ${`${workspaceId}:${String(seq)}`})`.execute(trx)
  return seq
}

/** Rows per INSERT when many are written at once, well under Postgres's parameter limit. */
const INSERT_CHUNK = 1000

/**
 * Appends one revision per entry, for writes that change many items at once (#112). It runs
 * last, after every item row is written, and holds the workspace row for a few statements only:
 * the sequence numbers, one INSERT per 1,000 revisions, and one NOTIFY statement.
 *
 * workspace_guard (migration 0008) lets the API role move `next_revision_seq` one step per
 * UPDATE, so in a request the N steps run server-side in one DO statement, on the workspace the
 * request is scoped to (`app.workspace_id`). A DO block takes no parameters, so the count goes in
 * as a transaction-local setting. Outside a request (the owner, which the guard skips) it is one
 * UPDATE.
 */
export async function appendRevisions(
  trx: Trx,
  workspaceId: string,
  actor: string,
  revisions: { hubId: string; itemId: string; version: number; patch: RevisionPatch }[],
): Promise<void> {
  const n = revisions.length
  if (n === 0) return
  if (isScoped(trx)) {
    await sql`SELECT set_config('app.revision_steps', ${String(n)}, true)`.execute(trx)
    await sql`
      DO $$
      BEGIN
        FOR i IN 1 .. current_setting('app.revision_steps')::int LOOP
          UPDATE workspace SET next_revision_seq = next_revision_seq + 1
          WHERE id = current_setting('app.workspace_id');
          IF NOT FOUND THEN
            RAISE EXCEPTION 'no workspace row to take revision numbers from';
          END IF;
        END LOOP;
      END
      $$
    `.execute(trx)
  } else {
    const moved = await trx
      .updateTable('workspace')
      .set({ next_revision_seq: sql`next_revision_seq + ${n}` })
      .where('id', '=', workspaceId)
      .executeTakeFirst()
    if (moved.numUpdatedRows === 0n) {
      throw new Error(`no workspace row ${workspaceId} to take revision numbers from`)
    }
  }
  const { next } = await trx
    .selectFrom('workspace')
    .select('next_revision_seq as next')
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow()
  const first = next - n
  const rows = revisions.map((r, i) => ({
    workspace_id: workspaceId,
    seq: first + i,
    item_id: r.itemId,
    hub_id: r.hubId,
    version: r.version,
    patch: JSON.stringify(r.patch),
    actor,
  }))
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await trx
      .insertInto('revision')
      .values(rows.slice(i, i + INSERT_CHUNK))
      .execute()
  }
  await sql`
    SELECT pg_notify(${REVISION_CHANNEL}, ${`${workspaceId}:`} || s::text)
    FROM generate_series(${first}::bigint, ${next - 1}::bigint) AS s
  `.execute(trx)
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

/**
 * Keeps item_index in step with `values` for the indexed attributes among them (D6): every row
 * of the item for each such attribute is replaced, so a multi-valued type can shrink or grow.
 * `null` in `values` clears the attribute's rows. Runs in the item's write transaction.
 */
export async function writeIndex(
  trx: Trx,
  workspaceId: string,
  itemId: string,
  definitions: FolderAttributeDefinition[],
  values: ItemValues,
  replace: boolean,
): Promise<void> {
  const touched = definitions
    .map((d) => d.attribute)
    .filter((a) => a.indexed && Object.hasOwn(values, a.id))
  if (touched.length === 0) return
  if (replace) {
    await trx
      .deleteFrom('item_index')
      .where('workspace_id', '=', workspaceId)
      .where('item_id', '=', itemId)
      .where(
        'attribute_id',
        'in',
        touched.map((a) => a.id),
      )
      .execute()
  }
  const rows = touched.flatMap((attribute) =>
    indexEntries(attribute, values[attribute.id] ?? null).map((entry) => ({
      workspace_id: workspaceId,
      attribute_id: attribute.id,
      item_id: itemId,
      ord: entry.ord,
      num: entry.column === 'num' ? (entry.value as number) : null,
      txt: entry.column === 'txt' ? (entry.value as string) : null,
      ts: entry.column === 'ts' ? (entry.value as string) : null,
    })),
  )
  if (rows.length > 0) await trx.insertInto('item_index').values(rows).execute()
}

type RelationAttribute = Extract<Attribute, { type: 'relation' }>

/** Relation attributes among `definitions` that `values` sets or clears. */
function touchedRelations(
  definitions: FolderAttributeDefinition[],
  values: ItemValues,
): RelationAttribute[] {
  return definitions
    .map((d) => d.attribute)
    .filter((a): a is RelationAttribute => a.type === 'relation' && Object.hasOwn(values, a.id))
}

const linkedIds = (values: ItemValues, attribute: RelationAttribute): string[] =>
  (values[attribute.id] as string[] | null | undefined) ?? []

/**
 * Checks every item a relation value links to and locks it FOR KEY SHARE until commit. Returns
 * `values` with stale IDs dropped.
 *
 * Every target must exist, sit in the attribute's target hub, and stay inside the attribute's
 * own hub unless `crossHub` is on (D11). A target that is new compared with `stored` (the
 * item's value before this write, per attribute) must also be readable by the writer; one
 * already stored is kept even if the writer cannot read it, since they already see its ID. A
 * stored target that has since been deleted is dropped silently, so a client can send back
 * the value it read. A missing new target and an unreadable new one get the same error, so
 * hidden items cannot be probed.
 */
async function checkTargets(
  trx: Trx,
  workspaceId: string,
  actor: string,
  relations: RelationAttribute[],
  values: ItemValues,
  stored: ItemValues,
): Promise<ItemValues> {
  const ids = [...new Set(relations.flatMap((a) => linkedIds(values, a)))].sort()
  if (ids.length === 0) return values
  // In a request, through lock_link_targets (migration 0008): row-level security hides items
  // in hubs the writer can't read, but a stored link to one is kept, so its existence is
  // needed. Its hub comes back null. Seeds and imports run as the owner, outside RLS, and read
  // the table.
  const rows: { id: string; hub_id: string | null }[] = isScoped(trx)
    ? (
        await sql<{ id: string; hub_id: string | null }>`
          SELECT id, hub_id FROM lock_link_targets(${ids}::text[])
        `.execute(trx)
      ).rows
    : await trx
        .selectFrom('item')
        .select(['id', 'hub_id'])
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', ids)
        .orderBy('id')
        .forKeyShare()
        .execute()
  const hubOf = new Map(rows.map((r) => [r.id, r.hub_id]))
  const readable = await readableHubs(
    trx,
    workspaceId,
    await loadSubject(trx, workspaceId, actor),
    rows.flatMap((r) => (r.hub_id === null ? [] : [r.hub_id])),
  )

  const errors: ValueError[] = []
  const kept: ItemValues = { ...values }
  for (const attribute of relations) {
    const before = new Set(linkedIds(stored, attribute))
    const ids = linkedIds(values, attribute)
    for (const id of ids) {
      const hub = hubOf.get(id)
      const fail = (message: string) =>
        errors.push({ attributeId: attribute.id, code: 'invalid_value', message })
      if (hub === undefined) {
        if (!before.has(id)) fail(`Item "${id}" not found`)
      } else if (!before.has(id) && (hub === null || !readable.has(hub))) {
        fail(`Item "${id}" not found`)
      } else if (hub === null) {
        // Stored, but in a hub the writer can't read: it was checked when it was stored, and
        // items never move between hubs.
      } else if (hub !== attribute.hubId && !attribute.config.crossHub) {
        fail(`Item "${id}" is in another hub, and this relation does not allow cross-hub links`)
      } else if (hub !== attribute.config.targetHubId) {
        fail(`Item "${id}" is not in this relation's target hub`)
      }
    }
    const live = ids.filter((id) => hubOf.has(id))
    // An empty relation is stored as no value, as validation does for `[]`.
    if (live.length < ids.length) kept[attribute.id] = live.length > 0 ? live : null
  }
  if (errors.length > 0) {
    throw new HttpError('invalid_values', 'Some values are not valid', { errors })
  }
  return kept
}

/**
 * Keeps `link` in step with the relation values in `values` (D7): every row of the item for
 * each such attribute is replaced. `null` clears them. Runs in the item's write transaction,
 * after `checkTargets`.
 */
async function writeLinks(
  trx: Trx,
  workspaceId: string,
  itemId: string,
  relations: RelationAttribute[],
  values: ItemValues,
  replace: boolean,
): Promise<void> {
  if (relations.length === 0) return
  if (replace) {
    await trx
      .deleteFrom('link')
      .where('workspace_id', '=', workspaceId)
      .where('from_item', '=', itemId)
      .where(
        'attribute_id',
        'in',
        relations.map((a) => a.id),
      )
      .execute()
  }
  const rows = relations.flatMap((attribute) =>
    linkedIds(values, attribute).map((to) => ({
      workspace_id: workspaceId,
      from_item: itemId,
      attribute_id: attribute.id,
      to_item: to,
    })),
  )
  if (rows.length > 0) await trx.insertInto('link').values(rows).execute()
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
  return inTransaction(db, async (trx) => {
    const folder = await trx
      .selectFrom('folder')
      .select(['id', 'hub_id'])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', input.folderId)
      .executeTakeFirst()
    if (!folder) throw notFound('Folder')
    // Before reading the attributes, so a schema write that strips values can't commit
    // between this validation and the insert (schema-lock.ts).
    await lockHubSchema(trx, workspaceId, folder.hub_id, 'shared')
    const definitions = await folderDefinitions(trx, workspaceId, folder.id)
    const values = stripNulls(validate(definitions, input.values, false))
    const id = input.id ?? randomUUID()
    const relations = touchedRelations(definitions, values)
    const autoIds = definitions.map((d) => d.attribute).filter((a) => a.type === 'auto_id')

    // History outlives a deleted item, so an ID is never reused, even after a delete.
    const used = await trx
      .selectFrom('revision')
      .select('seq')
      .where('workspace_id', '=', workspaceId)
      .where('item_id', '=', id)
      .limit(1)
      .executeTakeFirst()
    if (used) throw new HttpError('id_taken', 'This item ID is already used')

    // Before the hub row: see the lock order above.
    await checkTargets(trx, workspaceId, actor, relations, values, {})

    const { seq_id } = await trx
      .updateTable('folder')
      .set({ next_seq: sql`next_seq + 1` })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folder.hub_id)
      .returning(sql<number>`next_seq - 1`.as('seq_id'))
      .executeTakeFirstOrThrow()
    await bumpCounts(trx, workspaceId, folder.hub_id, folder.id, 1)
    // A folder delete that committed while this write waited for the hub row (#112).
    const live = await trx
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folder.id)
      .executeTakeFirst()
    if (!live) throw notFound('Folder')
    // Auto IDs are the item's seqId, written once here; clients cannot set them.
    const stored: ItemValues = { ...values }
    for (const attribute of autoIds) stored[attribute.id] = seq_id

    const row = await trx
      .insertInto('item')
      .values({
        workspace_id: workspaceId,
        id,
        hub_id: folder.hub_id,
        folder_id: folder.id,
        seq_id,
        values: JSON.stringify(stored),
        updated_by: actor,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) throw new HttpError('id_taken', 'This item ID is already used')

    await writeIndex(trx, workspaceId, id, definitions, stored, false)
    await writeLinks(trx, workspaceId, id, relations, stored, false)
    try {
      await appendRevision(
        trx,
        workspaceId,
        folder.hub_id,
        id,
        row.version,
        { op: 'create', folderId: folder.id, values: stored },
        actor,
      )
    } catch (error) {
      // The ID belonged to an item since deleted in a hub the writer can't read, so the check
      // above could not see its history (row-level security). Still never reused.
      if ((error as { constraint?: string }).constraint === REVISION_VERSION_KEY) {
        throw new HttpError('id_taken', 'This item ID is already used')
      }
      throw error
    }
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
  return inTransaction(db, async (trx) => {
    const before = await getItem(trx, workspaceId, id)
    // Before reading the attributes: see createItem and schema-lock.ts.
    await lockHubSchema(trx, workspaceId, before.hubId, 'shared')
    const definitions = await folderDefinitions(trx, workspaceId, before.folderId)
    const validated = validate(definitions, input.values, true)
    const relations = touchedRelations(definitions, validated)

    // NO KEY UPDATE, like the UPDATE below, so writers linking to this item are not blocked.
    const current = await trx
      .selectFrom('item')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .forNoKeyUpdate()
      .executeTakeFirst()
    if (!current) throw notFound('Item')
    if (current.version !== input.version) throw conflict(toItem(current))

    // The item cannot change folder, so the definitions read before the transaction still apply.
    const patch = await checkTargets(trx, workspaceId, actor, relations, validated, current.values)
    // Dropping stale IDs can empty a relation: check it again, so a required one is refused.
    const emptied = Object.keys(patch).filter((k) => patch[k] === null && validated[k] !== null)
    if (emptied.length > 0) {
      validate(definitions, Object.fromEntries(emptied.map((k) => [k, null])), true)
    }
    const cleared = Object.keys(patch).filter((key) => patch[key] === null)
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
      .returningAll()
      .executeTakeFirstOrThrow()

    await writeLinks(trx, workspaceId, id, relations, patch, true)
    await writeIndex(trx, workspaceId, id, definitions, patch, true)
    await appendRevision(
      trx,
      workspaceId,
      row.hub_id,
      id,
      row.version,
      { op: 'update', values: patch },
      actor,
    )
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
  await inTransaction(db, async (trx) => {
    const row = await trx
      .deleteFrom('item')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .where('version', '=', version)
      .returning(['hub_id', 'folder_id', 'version'])
      .executeTakeFirst()
    if (!row) throw conflict(await getItem(trx, workspaceId, id))

    // item_index rows and links from and to the item go with it (ON DELETE CASCADE). Relation
    // values in other items keep the ID; with no link left, readers treat it as gone. The
    // DELETE comes first: other writers hold links to this item while they wait for the hub,
    // folder or workspace row, so cascading after taking those could deadlock. The delete
    // revision is checked against the deleted item by revision_guard (migration 0008).
    await bumpCounts(trx, workspaceId, row.hub_id, row.folder_id, -1)
    // The delete is the item's last version, so `(item_id, version)` stays unique in the log.
    await appendRevision(trx, workspaceId, row.hub_id, id, row.version + 1, { op: 'delete' }, actor)
  })
}

// Queries (D19, D20): one folder, `where` and `sort` on item_index, keyset paging.

/** How a sort key is typed, for its SQL casts and its cursor form. */
type KeyKind = 'num' | 'txt' | 'ts'

/** One ORDER BY key, computed per item as `k<i>` in the inner query. */
interface SortKey {
  expr: RawBuilder<unknown>
  kind: KeyKind
  desc: boolean
  /** Items with no value have `null` and sort last in either direction. */
  nullable: boolean
}

const CAST: Record<KeyKind, RawBuilder<unknown>> = {
  num: sql`double precision`,
  txt: sql`text`,
  ts: sql`timestamptz`,
}
const typed = (kind: KeyKind, value: string | number) => sql`${value}::${CAST[kind]}`

/** `% _ \` are literal in the search text, not ILIKE wildcards. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

function conditionSql(filter: CompiledFilter): RawBuilder<unknown> {
  if ('and' in filter || 'or' in filter) {
    const children = 'and' in filter ? filter.and : filter.or
    if (children.length === 0) return 'and' in filter ? sql`TRUE` : sql`FALSE`
    return sql`(${sql.join(children.map(conditionSql), 'and' in filter ? sql` AND ` : sql` OR `)})`
  }
  const { attributeId, column, op, operands } = filter.condition
  const col = sql.ref(`x.${column}`)
  const one = operands[0] ?? ''
  const exists = (predicate: RawBuilder<unknown>) =>
    sql`EXISTS (SELECT 1 FROM item_index x WHERE x.workspace_id = i.workspace_id AND x.attribute_id = ${attributeId} AND x.item_id = i.id AND ${predicate})`
  const eq =
    column === 'txt'
      ? // Lets item_index_txt_idx narrow the rows before the full comparison.
        sql`left(x.txt, 256) = left(${one}::text, 256) AND x.txt = ${one}::text`
      : sql`${col} = ${typed(column, one)}`
  const inList = sql`${col} = ANY(${operands}::${CAST[column]}[])`
  const contains = sql`x.txt ILIKE ${`%${escapeLike(String(one))}%`}`

  switch (op) {
    case 'eq':
      return exists(eq)
    case 'neq':
      return sql`NOT ${exists(eq)}`
    case 'gt':
      return exists(sql`${col} > ${typed(column, one)}`)
    case 'gte':
      return exists(sql`${col} >= ${typed(column, one)}`)
    case 'lt':
      return exists(sql`${col} < ${typed(column, one)}`)
    case 'lte':
      return exists(sql`${col} <= ${typed(column, one)}`)
    case 'in':
      return exists(inList)
    case 'not_in':
      return sql`NOT ${exists(inList)}`
    case 'contains':
      return exists(contains)
    case 'not_contains':
      return sql`NOT ${exists(contains)}`
    case 'starts_with':
      return exists(sql`x.txt ILIKE ${`${escapeLike(String(one))}%`}`)
    case 'is_empty':
      return sql`NOT ${exists(sql`TRUE`)}`
    case 'is_not_empty':
      return exists(sql`TRUE`)
  }
}

function sortKey(sort: CompiledSort): SortKey {
  // The ord 0 row: a multi-valued attribute sorts by its first value.
  const value = (expr: RawBuilder<unknown>) =>
    sql`(SELECT ${expr} FROM item_index s WHERE s.workspace_id = i.workspace_id AND s.attribute_id = ${sort.attributeId} AND s.item_id = i.id AND s.ord = 0)`
  const desc = sort.direction === 'desc'
  switch (sort.key.by) {
    case 'value':
      return { expr: value(sql.ref(`s.${sort.column}`)), kind: sort.column, desc, nullable: true }
    case 'lower':
      return { expr: value(sql`lower(s.txt)`), kind: 'txt', desc, nullable: true }
    case 'position': {
      // Option order; a value whose option was deleted sorts after every option.
      const { order } = sort.key
      const position = sql`coalesce(array_position(${order}::text[], s.txt) - 1, ${order.length})`
      return { expr: value(position), kind: 'num', desc, nullable: true }
    }
  }
}

const NEWEST_FIRST: SortKey = {
  expr: sql`i.updated_at`,
  kind: 'ts',
  desc: true,
  nullable: false,
}

const CURSOR_VALUE: Record<KeyKind, z.ZodType> = {
  num: z.number(),
  txt: z.string().max(20_000),
  ts: z.iso.datetime(),
}

/**
 * Rows after the cursor in `ORDER BY k0, k1, ..., id` with nulls last:
 * OR over i of (k0..k(i-1) equal to the cursor, and ki after it).
 *
 * When no key is nullable and every key runs in the ID's direction (the default order), this
 * is a row comparison instead, which Postgres matches to a btree index such as
 * item_folder_updated_idx. The OR form cannot use the index and sorts the whole folder.
 */
function afterCursor(keys: SortKey[], idDesc: boolean, cursor: unknown[]): RawBuilder<unknown> {
  const ref = (i: number) => sql.ref(`q.k${String(i)}`)
  if (keys.every((key) => !key.nullable && key.desc === idDesc)) {
    const values = keys.map((key, i) => typed(key.kind, cursor[i] as string | number))
    const row = sql`(${sql.join([...keys.map((_, i) => ref(i)), sql.ref('q.id')])})`
    const at = sql`(${sql.join([...values, sql`${cursor.at(-1) as string}`])})`
    return idDesc ? sql`${row} < ${at}` : sql`${row} > ${at}`
  }
  const equal = (key: SortKey, i: number, c: unknown) =>
    c === null ? sql`${ref(i)} IS NULL` : sql`${ref(i)} = ${typed(key.kind, c as string | number)}`
  const after = (key: SortKey, i: number, c: unknown) => {
    // Null is last, so nothing comes after it on this key; ties fall to the next key.
    if (c === null) return sql`FALSE`
    const value = typed(key.kind, c as string | number)
    const beyond = key.desc ? sql`${ref(i)} < ${value}` : sql`${ref(i)} > ${value}`
    return key.nullable ? sql`(${beyond} OR ${ref(i)} IS NULL)` : beyond
  }

  const id = cursor.at(-1) as string
  const branches: RawBuilder<unknown>[] = []
  for (let i = 0; i <= keys.length; i++) {
    const prefix = keys.slice(0, i).map((key, j) => equal(key, j, cursor[j]))
    const key = keys[i]
    const last = key ? after(key, i, cursor[i]) : idDesc ? sql`q.id < ${id}` : sql`q.id > ${id}`
    branches.push(sql`(${sql.join([...prefix, last], sql` AND `)})`)
  }
  return sql`(${sql.join(branches, sql` OR `)})`
}

type QueryRow = Parameters<typeof toItem>[0] & Record<string, unknown>

export interface ItemQuery {
  from: string
  where: Filter | null
  sort: { attribute: string; direction: 'asc' | 'desc' }[]
  expand?: string[]
  limit: number
  cursor: string | null
}

/**
 * A folder's items, filtered and sorted on indexed attributes, keyset-paged. With no `sort`,
 * newest update first. The cursor holds the last row's sort values and ID. With `expand`, the
 * items the page links to through those relations come back in `linked`, one level deep (D20).
 */
export async function queryItems(
  db: Db,
  workspaceId: string,
  actor: Subject,
  query: ItemQuery,
  caps: { maxLinkedItems?: number } = {},
): Promise<ItemQueryResult> {
  const { statement, keys, sorted, expand } = await itemQueryStatement(db, workspaceId, query)
  const { rows } = await statement.execute(db)
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  const result: ItemQueryResult = {
    items: page.map((row) => toItem(row)),
    nextCursor:
      rows.length > query.limit && last
        ? sorted
          ? encodeItemCursor({
              order: 'sort',
              after: [
                ...keys.map((_, i) => last[`c${String(i)}`] as string | number | null),
                last.id,
              ],
            })
          : // The default order has one key, `updated_at` in microsecond text form.
            encodeItemCursor({ order: 'updated', after: [last['c0'] as string, last.id] })
        : null,
  }
  if (expand.length > 0) {
    const { linked, truncated } = await linkedItems(
      db,
      workspaceId,
      actor,
      page.map((row) => row.id),
      expand,
      caps.maxLinkedItems ?? MAX_LINKED_ITEMS,
    )
    result.linked = linked
    result.linkedTruncated = truncated
  }
  return result
}

/**
 * The items that `fromIds` link to through `attributeIds`, keyed by ID: the item where the
 * caller can read its hub, a "no access" marker otherwise. The first `cap` by ID, with
 * `truncated` set if there were more. Without the cap a page could pull in
 * 200 items x 3 attributes x 100 links = 60,000 items.
 */
async function linkedItems(
  db: Db,
  workspaceId: string,
  actor: Subject,
  fromIds: string[],
  attributeIds: string[],
  cap: number,
): Promise<{ linked: Record<string, LinkedItem>; truncated: boolean }> {
  if (fromIds.length === 0) return { linked: {}, truncated: false }
  // A link row exists only while its target does (ON DELETE CASCADE), so the targets come from
  // `link`; the items themselves are read only where the caller may. Under row-level security
  // the others are not even visible, and they become "no access".
  const targets = await db
    .selectFrom('link')
    .select('to_item')
    .distinct()
    .where('workspace_id', '=', workspaceId)
    .where('from_item', 'in', fromIds)
    .where('attribute_id', 'in', attributeIds)
    .orderBy('to_item')
    .limit(cap + 1)
    .execute()
  const shown = targets.slice(0, cap).map((t) => t.to_item)
  const rows =
    shown.length === 0
      ? []
      : await db
          .selectFrom('item')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('id', 'in', shown)
          .execute()
  const readable = await readableHubs(
    db,
    workspaceId,
    actor,
    rows.map((r) => r.hub_id),
  )
  const byId = new Map(rows.filter((r) => readable.has(r.hub_id)).map((r) => [r.id, r]))
  return {
    linked: Object.fromEntries(
      shown.map((id): [string, LinkedItem] => {
        const row = byId.get(id)
        return [id, row ? { access: 'read', item: toItem(row) } : { access: 'none' }]
      }),
    ),
    truncated: targets.length > cap,
  }
}

/**
 * One item with the items it links to through `expand`, as `POST /query` returns them for a
 * page: the same attribute rules (relations shown on the item's folder) and the same cap. The
 * caller must already be allowed to read the item.
 */
export async function expandItem(
  db: Db,
  workspaceId: string,
  actor: Subject,
  item: Item,
  expand: string[],
  caps: { maxLinkedItems?: number } = {},
): Promise<ItemRead> {
  const definitions = await folderDefinitions(db, workspaceId, item.folderId)
  const compiled = compileOrThrow(definitions, { where: null, sort: [], expand })
  const { linked, truncated } = await linkedItems(
    db,
    workspaceId,
    actor,
    [item.id],
    compiled.expand,
    caps.maxLinkedItems ?? MAX_LINKED_ITEMS,
  )
  return { ...item, linked, linkedTruncated: truncated }
}

/** `compileItemQuery`, with its problems as a 400 `invalid_request` listing every one. */
function compileOrThrow(
  definitions: FolderAttributeDefinition[],
  query: Parameters<typeof compileItemQuery>[1],
): Extract<ReturnType<typeof compileItemQuery>, { ok: true }> {
  const compiled = compileItemQuery(
    definitions.map((d) => d.attribute),
    query,
  )
  if (!compiled.ok) {
    throw new HttpError(
      'invalid_request',
      compiled.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      { errors: compiled.errors },
    )
  }
  return compiled
}

const backlinkCursorSchema = z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)])

/**
 * The items that link to `id`, by linking item ID, then attribute ID. The item itself must be
 * readable (404 otherwise, docs/ROLES.md). Only linking items the caller can read are listed;
 * the others are counted in `hidden`, up to `maxHidden`, and never named, so a hub the caller
 * cannot see does not show through.
 */
export async function backlinks(
  db: Db,
  workspaceId: string,
  actor: Subject,
  id: string,
  page: { limit: number; cursor?: string | undefined },
  maxHidden: number = MAX_HIDDEN_BACKLINKS,
): Promise<BacklinkPage> {
  const target = await getItem(db, workspaceId, id)
  const readable = await allReadableHubs(db, workspaceId, actor)
  if (!readable.includes(target.hubId)) throw notFound('Item')

  const linking = () =>
    db
      .selectFrom('link as l')
      .innerJoin('item as i', (join) =>
        join.onRef('i.workspace_id', '=', 'l.workspace_id').onRef('i.id', '=', 'l.from_item'),
      )
      .where('l.workspace_id', '=', workspaceId)
      .where('l.to_item', '=', id)

  let q = linking()
    .selectAll('i')
    .select('l.attribute_id as link_attribute_id')
    .where('i.hub_id', 'in', readable)
  if (page.cursor) {
    const [from, attribute] = decodeCursor(backlinkCursorSchema, page.cursor)
    q = q.where(sql<boolean>`(l.from_item, l.attribute_id) > (${from}, ${attribute})`)
  }
  const [rows, hidden] = await Promise.all([
    q
      .orderBy('l.from_item')
      .orderBy('l.attribute_id')
      .limit(page.limit + 1)
      .execute(),
    hiddenBacklinks(db, id, maxHidden),
  ])
  const shown = rows.slice(0, page.limit)
  const last = shown.at(-1)
  return {
    items: shown.map(({ link_attribute_id: attributeId, ...row }) => ({
      attributeId,
      item: toItem(row),
    })),
    nextCursor:
      rows.length > page.limit && last ? encodeCursor([last.id, last.link_attribute_id]) : null,
    hidden,
  }
}

/**
 * Links to `id` from items the caller can't read, up to `maxHidden`. Row-level security hides
 * those items and their links, so the count comes from `hidden_backlinks` (migration 0008),
 * which returns a number only. Request-scoped only: it reads the caller from the transaction.
 */
async function hiddenBacklinks(db: Db, id: string, maxHidden: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT hidden_backlinks(${id}, ${maxHidden}) AS n
  `.execute(db)
  return rows[0]?.n ?? 0
}

/**
 * The SQL for one page of `queryItems`, fetching one row past the limit. Exported so tests can
 * EXPLAIN it: the default order must stay an index scan on item_folder_updated_idx (D20).
 */
export async function itemQueryStatement(
  db: Db,
  workspaceId: string,
  query: ItemQuery,
): Promise<{
  statement: RawBuilder<QueryRow>
  keys: SortKey[]
  sorted: boolean
  expand: string[]
}> {
  const folder = await db
    .selectFrom('folder')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', query.from)
    .executeTakeFirst()
  if (!folder) throw notFound('Folder')

  let where: CompiledFilter | null = null
  let sorts: CompiledSort[] = []
  let expand: string[] = []
  if (query.where || query.sort.length > 0 || (query.expand?.length ?? 0) > 0) {
    const definitions = await folderDefinitions(db, workspaceId, folder.id)
    const compiled = compileOrThrow(definitions, {
      where: query.where,
      sort: query.sort,
      expand: query.expand,
    })
    where = compiled.where
    sorts = compiled.sort
    expand = compiled.expand
  }

  const keys = sorts.length > 0 ? sorts.map(sortKey) : [NEWEST_FIRST]
  // Ties end on the ID, in the direction of the default order when there is no sort.
  const idDesc = sorts.length === 0

  // The cursor records its order (core's `itemQuerySchema` refuses one from another order at
  // the edge); its keys must also fit this sort's key types.
  let cursor: unknown[] | null = null
  if (query.cursor) {
    const decoded = decodeItemCursor(query.cursor)
    const schema = z.tuple([
      ...keys.map((k) => (k.nullable ? CURSOR_VALUE[k.kind].nullable() : CURSOR_VALUE[k.kind])),
      z.string().min(1).max(64),
    ] as unknown as [z.ZodType, ...z.ZodType[]])
    const keysFit = decoded && schema.safeParse(decoded.after)
    if (
      !decoded ||
      decoded.order !== (sorts.length > 0 ? 'sort' : 'updated') ||
      !keysFit?.success
    ) {
      throw new HttpError('invalid_request', 'Invalid cursor')
    }
    cursor = keysFit.data
  }

  // Timestamps go into the cursor in microsecond text form: a JS Date would drop precision and
  // skip or repeat rows.
  const cursorForm = (key: SortKey, i: number) =>
    key.kind === 'ts'
      ? sql`to_char(${sql.ref(`q.k${String(i)}`)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : sql.ref(`q.k${String(i)}`)

  const statement = sql<QueryRow>`
    SELECT q.*, ${sql.join(keys.map((k, i) => sql`${cursorForm(k, i)} AS ${sql.id(`c${String(i)}`)}`))}
    FROM (
      SELECT i.*, ${sql.join(keys.map((k, i) => sql`${k.expr} AS ${sql.id(`k${String(i)}`)}`))}
      FROM item i
      WHERE i.workspace_id = ${workspaceId}
        AND i.folder_id = ${folder.id}
        AND ${where ? conditionSql(where) : sql`TRUE`}
    ) q
    WHERE ${cursor ? afterCursor(keys, idDesc, cursor) : sql`TRUE`}
    ORDER BY ${sql.join([
      ...keys.map(
        // NULLS LAST only where nulls occur: on a NOT NULL key it would still stop the planner
        // from matching a DESC index, which keeps nulls first.
        (k, i) =>
          sql`${sql.ref(`q.k${String(i)}`)} ${k.desc ? sql`DESC` : sql`ASC`}${k.nullable ? sql` NULLS LAST` : sql``}`,
      ),
      idDesc ? sql`q.id DESC` : sql`q.id ASC`,
    ])}
    LIMIT ${query.limit + 1}
  `
  return { statement, keys, sorted: sorts.length > 0, expand }
}
