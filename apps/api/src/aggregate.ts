import {
  AGGREGATE_TIMEOUT_MS,
  checkAggregate,
  MAX_AGGREGATE_GROUPS,
  MAX_DATE_BUCKETS,
  type AggregateGroup,
  type AggregateResult,
  type Attribute,
  type CompiledFilter,
  type MeasureValue,
  type ParsedAggregateRequest,
  type Subject,
  type SummaryFunction,
} from '@16bit/core'
import { sql, type RawBuilder, type Transaction } from 'kysely'
import { checkHub, folderHub } from './access.ts'
import type { Database } from './db/database.ts'
import { HttpError, sqlState } from './http.ts'
import { compileOrThrow, folderDefinitions, leafPredicate } from './items.ts'
import { checkTimeZone, resolveReadFilters } from './read-operands.ts'

// The aggregate engine (D80, #255): `POST /aggregate`, and later the number, chart and list
// group blocks of views. It reads as the caller, under row-level security, in the request's
// snapshot (D79).
//
// One statement, built as the #251 spike found fastest and flat in the number of conditions:
// the folder's items are joined to ONE scan of `item_index` for every attribute the request
// names, grouped by item into a row (`v`). Each condition of `where` and of every measure's
// `where` becomes a column `c<n> = bool_or(predicate) FILTER (WHERE attribute_id = ...)`, with
// the predicate of `/query`'s compiler (`leafPredicate`, items.ts), so a filter tree is a
// boolean expression over columns. A `NOT EXISTS` per condition inside `FILTER`, as `/query`
// compiles a filter, timed out at the 40-condition cap on 50,000 items. Under row-level security
// the `item_index_read` policy costs one hash of the caller's readable items per scan, so one
// scan pays it once.
//
// Groups: the dimension's values come as an array per item and are unnested, so a multi-valued
// attribute counts an item in each of its groups, and each (item, group) pair once. Value groups
// are ranked (option order, bucket order, boolean order, or the first measure largest first
// for actors and relations); past the cap they fold into one `other` group, whose measures are
// computed over its items, each once. Relation targets the caller can't read (the join to
// `item` is under row-level security) fold into one `no_access` group, so neither their IDs nor
// their number shows; a target that was deleted is indistinguishable and folds there too.
//
// Sums and averages are computed in `numeric` from the stored doubles, so they don't drift with
// the plan's summation order (#251), and rounded to the attribute's `decimals` when it has them;
// averages without `decimals` to 10 places, in SQL. Past 366 date buckets the latest are kept and
// the oldest fold into `other`.

type Trx = Transaction<Database>

export interface AggregateOptions {
  /** Statement timeout; past it, 503 `timeout` (D80). Lowered in tests. */
  timeoutMs?: number
}

const AVG_DEFAULT_DECIMALS = 10

/**
 * `work_mem` for one aggregate statement. Per sort or hash node, per statement, and at most 4
 * requests in flight per principal (D83), so a few aggregates at once stay well within a pod.
 */
const AGGREGATE_WORK_MEM = '32MB'

/** A column of the per-item row `v`, built from the one item_index scan. */
interface PivotColumn {
  name: string
  expr: RawBuilder<unknown>
}

/** Collects the per-item columns and the attributes the scan reads. */
class Pivot {
  readonly columns: PivotColumn[] = []
  readonly attributes = new Set<string>()

  add(prefix: string, attributeId: string, expr: RawBuilder<unknown>): RawBuilder<unknown> {
    const name = `${prefix}${String(this.columns.length)}`
    this.columns.push({ name, expr })
    this.attributes.add(attributeId)
    return sql.ref(`b.${name}`)
  }

  /** A filter tree as a boolean over `b` (the per-item row). */
  filter(f: CompiledFilter | null): RawBuilder<unknown> {
    if (f === null) return sql`TRUE`
    if ('and' in f || 'or' in f) {
      const children = 'and' in f ? f.and : f.or
      if (children.length === 0) return 'and' in f ? sql`TRUE` : sql`FALSE`
      return sql`(${sql.join(
        children.map((c) => this.filter(c)),
        'and' in f ? sql` AND ` : sql` OR `,
      )})`
    }
    const { attributeId } = f.condition
    const { predicate, negated } = leafPredicate(f.condition)
    const column = this.add(
      'c',
      attributeId,
      sql`coalesce(bool_or(${predicate}) FILTER (WHERE x.attribute_id = ${attributeId}), false)`,
    )
    const holds = sql`coalesce(${column}, false)`
    return negated ? sql`NOT ${holds}` : holds
  }

  /** Whether the item has any value for the attribute. */
  has(attributeId: string): RawBuilder<unknown> {
    return sql`coalesce(${this.add('h', attributeId, sql`bool_or(true) FILTER (WHERE x.attribute_id = ${attributeId})`)}, false)`
  }

  /** The attribute's first value (ord 0) in `column`. */
  first(attributeId: string, column: 'num' | 'txt' | 'ts'): RawBuilder<unknown> {
    return this.add(
      'm',
      attributeId,
      sql`max(${sql.ref(`x.${column}`)}) FILTER (WHERE x.attribute_id = ${attributeId} AND x.ord = 0)`,
    )
  }

  /** Every value of the attribute, in `ord` order. */
  all(attributeId: string, column: 'num' | 'txt' | 'ts'): RawBuilder<unknown> {
    return this.add(
      'g',
      attributeId,
      sql`array_agg(${sql.ref(`x.${column}`)} ORDER BY x.ord) FILTER (WHERE x.attribute_id = ${attributeId})`,
    )
  }
}

/** How a measure's raw result becomes its answer. */
type Shape = (raw: unknown) => MeasureValue

const asCount: Shape = (raw) => Number(raw ?? 0)
/** A `numeric` from Postgres (a decimal string), already rounded in SQL. */
const asNumber: Shape = (raw) => (raw === null || raw === undefined ? null : Number(raw))

/** `expr` rounded half away from zero to `decimals` places, exactly, in `numeric`. */
const rounded = (expr: RawBuilder<unknown>, decimals: number | undefined) =>
  decimals === undefined ? expr : sql`round(${expr}, ${sql.lit(decimals)})`
const asDate =
  (includeTime: boolean): Shape =>
  (raw) => {
    if (raw === null || raw === undefined) return null
    const iso = (raw instanceof Date ? raw : new Date(raw as string)).toISOString()
    return includeTime ? iso : iso.slice(0, 10)
  }

function measureSql(
  pivot: Pivot,
  fn: SummaryFunction,
  attribute: Attribute | undefined,
  where: RawBuilder<unknown>,
): { expr: RawBuilder<unknown>; shape: Shape } {
  const count = (also: RawBuilder<unknown> = sql`TRUE`) => ({
    expr: sql`count(*) FILTER (WHERE ${where} AND ${also})`,
    shape: asCount,
  })
  if (fn === 'count' || attribute === undefined) return count()
  const id = attribute.id
  const decimals = attribute.type === 'number' ? attribute.config.decimals : undefined
  switch (fn) {
    case 'count_empty':
      return count(sql`NOT ${pivot.has(id)}`)
    case 'count_not_empty':
      return count(pivot.has(id))
    case 'count_unique':
      return {
        expr: sql`count(DISTINCT ${pivot.first(id, 'txt')}) FILTER (WHERE ${where})`,
        shape: asCount,
      }
    case 'count_true':
      return count(sql`${pivot.first(id, 'num')} = 1`)
    case 'count_false':
      return count(sql`${pivot.first(id, 'num')} = 0`)
    case 'sum':
      return {
        expr: rounded(
          sql`sum(${pivot.first(id, 'num')}::numeric) FILTER (WHERE ${where})`,
          decimals,
        ),
        shape: asNumber,
      }
    case 'avg':
      return {
        expr: rounded(
          sql`avg(${pivot.first(id, 'num')}::numeric) FILTER (WHERE ${where})`,
          decimals ?? AVG_DEFAULT_DECIMALS,
        ),
        shape: asNumber,
      }
    case 'min':
      return {
        expr: sql`min(${pivot.first(id, 'num')}::numeric) FILTER (WHERE ${where})`,
        shape: asNumber,
      }
    case 'max':
      return {
        expr: sql`max(${pivot.first(id, 'num')}::numeric) FILTER (WHERE ${where})`,
        shape: asNumber,
      }
    case 'earliest':
    case 'latest': {
      const includeTime = attribute.type === 'date' && attribute.config.includeTime
      const agg = fn === 'earliest' ? sql`min` : sql`max`
      return {
        expr: sql`${agg}(${pivot.first(id, 'ts')}) FILTER (WHERE ${where})`,
        shape: asDate(includeTime),
      }
    }
  }
}

/** The index column a group dimension's values are in. */
const groupColumn = (a: Attribute): 'num' | 'txt' | 'ts' =>
  a.type === 'boolean' ? 'num' : a.type === 'date' ? 'ts' : 'txt'

/**
 * Runs an aggregate for `principal`, in its transaction (a request snapshot). Checks access to
 * `from` (404 when hidden), the time zone (422), the request against the folder's attributes
 * (400 listing every problem), resolves `$me` and `$now`, and answers the groups in order.
 */
export async function aggregate(
  trx: Trx,
  workspaceId: string,
  principal: Subject,
  request: ParsedAggregateRequest,
  options: AggregateOptions = {},
): Promise<Omit<AggregateResult, 'seq'>> {
  const hubId = await folderHub(trx, workspaceId, request.from)
  await checkHub(trx, workspaceId, principal, hubId, 'hub.read', 'Folder')
  const tz = request.tz ?? 'UTC'
  await checkTimeZone(trx, tz)
  const definitions = await folderDefinitions(trx, workspaceId, request.from)
  const attributes = definitions.map((d) => d.attribute)
  const problems = checkAggregate(attributes, request)
  if (problems.length > 0) {
    throw new HttpError(
      'invalid_request',
      problems.map((e) => `${e.path}: ${e.message}`).join('; '),
      { errors: problems },
    )
  }
  const [where, ...measureWheres] = await resolveReadFilters(trx, attributes, principal.id, tz, [
    { where: request.where, path: 'where' },
    ...request.measures.map((m, i) => ({ where: m.where, path: `measures.${String(i)}.where` })),
  ])
  const compile = (f: (typeof measureWheres)[number] | undefined) =>
    f ? compileOrThrow(definitions, { where: f, sort: [] }).where : null

  const byId = new Map(attributes.map((a) => [a.id, a]))
  const pivot = new Pivot()
  const whereExpr = pivot.filter(compile(where))
  const measures = request.measures.map((m, i) =>
    measureSql(
      pivot,
      m.fn,
      m.attribute === undefined ? undefined : byId.get(m.attribute),
      pivot.filter(compile(measureWheres[i])),
    ),
  )
  const groupAttribute = request.groupBy && byId.get(request.groupBy.attribute)
  const groupValues = groupAttribute
    ? pivot.all(groupAttribute.id, groupColumn(groupAttribute))
    : undefined

  const scan =
    pivot.columns.length === 0
      ? sql``
      : sql`LEFT JOIN (
          SELECT x.item_id, ${sql.join(pivot.columns.map((c) => sql`${c.expr} AS ${sql.ref(c.name)}`))}
          FROM item_index x
          WHERE x.workspace_id = ${workspaceId} AND x.attribute_id = ANY(${[...pivot.attributes]}::text[])
          GROUP BY x.item_id
        ) b ON b.item_id = i.id`
  const base = sql`
    SELECT i.id AS item ${pivot.columns.length === 0 ? sql`` : sql`, b.*`}
    FROM item i ${scan}
    WHERE i.workspace_id = ${workspaceId} AND i.folder_id = ${request.from} AND ${whereExpr}
  `
  const measureList = sql.join(
    measures.map((m, i) => sql`${m.expr} AS ${sql.ref(`v${String(i)}`)}`),
  )

  // The aggregate's own timeout, for its statement only: the previous value (a role or database
  // default, or the request's) comes back after it.
  // `work_mem` too: the pivot groups a few index rows per item and per attribute (about 400,000
  // rows for 50,000 items at the cap), which spills to disk at the default 4 MB.
  const { rows: previous } = await sql<{ timeout: string; memory: string }>`
    SELECT current_setting('statement_timeout') AS timeout,
           current_setting('work_mem') AS memory,
           set_config('statement_timeout', ${String(options.timeoutMs ?? AGGREGATE_TIMEOUT_MS)}, true),
           set_config('work_mem', ${AGGREGATE_WORK_MEM}, true)
  `.execute(trx)
  try {
    if (!groupAttribute || !groupValues) {
      const { rows } = await sql<Record<string, unknown>>`
        WITH base AS (${base}) SELECT ${measureList} FROM base b
      `.execute(trx)
      const row = rows[0] ?? {}
      return {
        groups: [
          { key: { kind: 'all' }, values: measures.map((m, i) => m.shape(row[`v${String(i)}`])) },
        ],
        truncated: false,
      }
    }
    return await grouped(trx, workspaceId, request, groupAttribute, groupValues, base, measures, tz)
  } catch (error) {
    if (sqlState(error) === '57014') {
      throw new HttpError('timeout', 'The aggregate took too long; narrow it with where')
    }
    throw error
  } finally {
    // A failed statement aborts the transaction, which ends the setting anyway.
    const timeout = previous[0]?.timeout ?? '0'
    const memory = previous[0]?.memory ?? '4MB'
    await sql`SELECT set_config('statement_timeout', ${timeout}, true),
                     set_config('work_mem', ${memory}, true)`
      .execute(trx)
      .catch(() => undefined)
  }
}

async function grouped(
  trx: Trx,
  workspaceId: string,
  request: ParsedAggregateRequest,
  attribute: Attribute,
  values: RawBuilder<unknown>,
  base: RawBuilder<unknown>,
  measures: { expr: RawBuilder<unknown>; shape: Shape }[],
  tz: string,
): Promise<Omit<AggregateResult, 'seq'>> {
  const bucket = request.groupBy?.bucket
  const isDate = attribute.type === 'date'
  const isRelation = attribute.type === 'relation'
  // A calendar date (no time) is stored as UTC midnight: it buckets as that date, not shifted
  // into the reader's zone. A date with time buckets in the reader's zone (D81).
  const zone = isDate && !attribute.config.includeTime ? 'UTC' : tz
  const key = isDate
    ? sql`to_char(date_trunc(${bucket ?? 'day'}, u.val AT TIME ZONE ${zone}), 'YYYY-MM-DD')`
    : attribute.type === 'boolean'
      ? sql`u.val::int::text`
      : sql`u.val::text`
  const kind = isRelation
    ? sql`CASE WHEN u.val IS NULL THEN 'empty' WHEN t.id IS NULL THEN 'no_access' ELSE 'value' END`
    : sql`CASE WHEN u.val IS NULL THEN 'empty' ELSE 'value' END`
  const relationJoin = isRelation
    ? sql`LEFT JOIN item t ON t.workspace_id = ${workspaceId} AND t.id = u.val`
    : sql``
  const cap = isDate ? MAX_DATE_BUCKETS : MAX_AGGREGATE_GROUPS
  const first = measures[0]?.expr ?? sql`count(*)`
  const order =
    attribute.type === 'select' || attribute.type === 'multi_select'
      ? sql`array_position(${attribute.config.options.map((o) => o.id)}::text[], g.gk) NULLS LAST, g.gk`
      : attribute.type === 'actor' || isRelation
        ? sql`g.m0 DESC NULLS LAST, g.gk`
        : isDate
          ? // The latest buckets are kept and the oldest fold into `other`: a burndown or a
            // trend cares about the recent end. They are shown ascending below.
            sql`g.gk DESC`
          : sql`g.gk`

  type Row = Record<string, unknown> & { kind: string; gk: string; r: number | null }
  const measureList = sql.join(
    measures.map((m, i) => sql`${m.expr} AS ${sql.ref(`v${String(i)}`)}`),
  )

  // A select, multi-select or boolean can't have more groups than the cap (at most 100
  // options; two values), so nothing ever folds into `other`: group in one pass, with `base`
  // read once (and inlined), and rank in option order here. Each value of a multi-select is in
  // the item's list once (core keeps the list distinct), so every (item, group) pair is one row
  // without a DISTINCT. The ranked and folded path below is for actors, relations and dates.
  const options =
    attribute.type === 'select' || attribute.type === 'multi_select'
      ? attribute.config.options.map((o) => o.id)
      : attribute.type === 'boolean'
        ? ['0', '1']
        : null
  if (options) {
    const { rows } = await sql<Row>`
      WITH base AS (${base})
      SELECT ${kind} AS kind,
             CASE WHEN ${kind} = 'value' THEN ${key} ELSE '' END AS gk,
             NULL::bigint AS r,
             ${measureList}
      FROM base b
      LEFT JOIN LATERAL unnest(${values}) AS u(val) ON true
      GROUP BY 1, 2
    `.execute(trx)
    // Option order; a value no longer among the options (impossible today, D51 strips them)
    // sorts after the options, by value.
    const position = (gk: string) => {
      const i = options.indexOf(gk)
      return i < 0 ? options.length : i
    }
    rows.sort((a, b) => position(a.gk) - position(b.gk) || a.gk.localeCompare(b.gk))
    rows.forEach((row, i) => {
      if (row.kind === 'value') row.r = i + 1
    })
    return shapeGroups(trx, workspaceId, attribute, rows, measures, false)
  }

  const { rows } = await sql<Row>`
    WITH base AS (${base}),
    keyed AS (
      SELECT DISTINCT b.item, ${kind} AS gkind,
             CASE WHEN ${kind} = 'value' THEN ${key} ELSE '' END AS gk
      FROM base b
      LEFT JOIN LATERAL unnest(${values}) AS u(val) ON true
      ${relationJoin}
    ),
    groups AS (
      SELECT k.gkind, k.gk, ${first} AS m0
      FROM keyed k JOIN base b ON b.item = k.item
      GROUP BY k.gkind, k.gk
    ),
    ranked AS (
      SELECT g.gkind, g.gk,
             CASE WHEN g.gkind = 'value'
                  THEN row_number() OVER (PARTITION BY g.gkind = 'value' ORDER BY ${order}) END AS r
      FROM groups g
    ),
    folded AS (
      SELECT DISTINCT k.item,
             CASE WHEN r.r > ${cap} THEN 'other' ELSE k.gkind END AS kind,
             CASE WHEN r.r > ${cap} THEN '' ELSE k.gk END AS gk,
             CASE WHEN r.r > ${cap} THEN NULL ELSE r.r END AS r
      FROM keyed k JOIN ranked r ON r.gkind = k.gkind AND r.gk = k.gk
    )
    SELECT f.kind, f.gk, f.r, ${measureList}
    FROM folded f JOIN base b ON b.item = f.item
    GROUP BY f.kind, f.gk, f.r
  `.execute(trx)
  return shapeGroups(trx, workspaceId, attribute, rows, measures, isDate)
}

/** Grouped rows as the answer: value groups by rank, then `no_access`, `empty`, `other`. */
async function shapeGroups(
  trx: Trx,
  workspaceId: string,
  attribute: Attribute,
  rows: (Record<string, unknown> & { kind: string; gk: string; r: number | null })[],
  measures: { expr: RawBuilder<unknown>; shape: Shape }[],
  isDate: boolean,
): Promise<Omit<AggregateResult, 'seq'>> {
  const isRelation = attribute.type === 'relation'
  const KIND_ORDER: Record<string, number> = { value: 0, no_access: 1, empty: 2, other: 3 }
  // Value groups by rank, but date buckets ascending (they are ranked latest first).
  const rank = (r: { r: number | null }) => (isDate ? -(r.r ?? 0) : (r.r ?? 0))
  rows.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || rank(a) - rank(b))
  const labels = isRelation
    ? await relationLabels(
        trx,
        workspaceId,
        rows.filter((r) => r.kind === 'value').map((r) => r.gk),
      )
    : new Map<string, string>()
  const groups: AggregateGroup[] = rows.map((row) => {
    const out = measures.map((m, i) => m.shape(row[`v${String(i)}`]))
    switch (row.kind) {
      case 'value': {
        const value = attribute.type === 'boolean' ? row.gk === '1' : row.gk
        const label = labels.get(row.gk)
        return { key: { kind: 'value', value, ...(label !== undefined && { label }) }, values: out }
      }
      case 'no_access':
        return { key: { kind: 'no_access' }, values: out }
      case 'empty':
        return { key: { kind: 'empty' }, values: out }
      default:
        return { key: { kind: 'other' }, values: out }
    }
  })
  return { groups, truncated: groups.some((g) => g.key.kind === 'other') }
}

/** Titles of relation targets the caller can read (D50): the hub's title attribute's value. */
async function relationLabels(
  trx: Trx,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { rows } = await sql<{ id: string; label: string | null }>`
    SELECT t.id, t.values ->> h.title_attribute_id AS label
    FROM item t
    JOIN folder h ON h.workspace_id = t.workspace_id AND h.id = t.hub_id
    WHERE t.workspace_id = ${workspaceId} AND t.id = ANY(${ids}::text[])
  `.execute(trx)
  return new Map(
    rows.flatMap((r) => (typeof r.label === 'string' && r.label !== '' ? [[r.id, r.label]] : [])),
  )
}
