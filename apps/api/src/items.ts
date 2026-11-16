import { randomUUID } from 'node:crypto'
import {
  compileItemQuery,
  indexEntries,
  validateItemValues,
  type CompiledFilter,
  type CompiledSort,
  type Filter,
  type FolderAttributeDefinition,
  type Item,
  type ItemValues,
  type Page,
  type PatchItem,
} from '@16bit/core'
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely'
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
// so taking it after the hub and folder cannot deadlock with them. An item's item_index rows
// are written while its item row is held, before the workspace row.

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

/**
 * Keeps item_index in step with `values` for the indexed attributes among them (D6): every row
 * of the item for each such attribute is replaced, so a multi-valued type can shrink or grow.
 * `null` in `values` clears the attribute's rows. Runs in the item's write transaction.
 */
async function writeIndex(
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
  const definitions = await folderDefinitions(db, workspaceId, folder.id)
  const values = stripNulls(validate(definitions, input.values, false))
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

    await writeIndex(trx, workspaceId, id, definitions, values, false)
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
  const definitions = await folderDefinitions(db, workspaceId, before.folderId)
  const patch = validate(definitions, input.values, true)
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

    // The item cannot change folder, so the definitions read before the transaction still apply.
    await writeIndex(trx, workspaceId, id, definitions, patch, true)
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

    // item_index rows go with the item (ON DELETE CASCADE).
    await bumpCounts(trx, workspaceId, row.hub_id, row.folder_id, -1)
    // The delete is the item's last version, so `(item_id, version)` stays unique in the log.
    await appendRevision(trx, workspaceId, id, row.version + 1, { op: 'delete' }, actor)
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
  limit: number
  cursor: string | null
}

/**
 * A folder's items, filtered and sorted on indexed attributes, keyset-paged. With no `sort`,
 * newest update first. The cursor holds the last row's sort values and ID.
 */
export async function queryItems(
  db: Db,
  workspaceId: string,
  query: ItemQuery,
): Promise<Page<Item>> {
  const { statement, keys } = await itemQueryStatement(db, workspaceId, query)
  const { rows } = await statement.execute(db)
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => toItem(row)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor([
            ...keys.map((_, i) => last[`c${String(i)}`] as string | number | null),
            last.id,
          ])
        : null,
  }
}

/**
 * The SQL for one page of `queryItems`, fetching one row past the limit. Exported so tests can
 * EXPLAIN it: the default order must stay an index scan on item_folder_updated_idx (D20).
 */
export async function itemQueryStatement(
  db: Db,
  workspaceId: string,
  query: ItemQuery,
): Promise<{ statement: RawBuilder<QueryRow>; keys: SortKey[] }> {
  const folder = await db
    .selectFrom('folder')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', query.from)
    .executeTakeFirst()
  if (!folder) throw notFound('Folder')

  let where: CompiledFilter | null = null
  let sorts: CompiledSort[] = []
  if (query.where || query.sort.length > 0) {
    const definitions = await folderDefinitions(db, workspaceId, folder.id)
    const compiled = compileItemQuery(
      definitions.map((d) => d.attribute),
      { where: query.where, sort: query.sort },
    )
    if (!compiled.ok) {
      throw new HttpError(
        'invalid_request',
        compiled.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        {
          errors: compiled.errors,
        },
      )
    }
    where = compiled.where
    sorts = compiled.sort
  }

  const keys = sorts.length > 0 ? sorts.map(sortKey) : [NEWEST_FIRST]
  // Ties end on the ID, in the direction of the default order when there is no sort.
  const idDesc = sorts.length === 0

  let cursor: unknown[] | null = null
  if (query.cursor) {
    const schema = z.tuple([
      ...keys.map((k) => (k.nullable ? CURSOR_VALUE[k.kind].nullable() : CURSOR_VALUE[k.kind])),
      z.string().min(1).max(64),
    ] as unknown as [z.ZodType, ...z.ZodType[]])
    cursor = decodeCursor(schema, query.cursor)
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
  return { statement, keys }
}
