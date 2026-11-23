import {
  AGGREGATE_TIMEOUT_MS,
  BLOCK_TYPES,
  blockDependencies,
  bindingOf,
  checkViewTree,
  MAX_DATE_BUCKETS,
  MAX_VIEW_DATA_ITEMS,
  VIEW_DATA_DEADLINE_MS,
  walkBlocks,
  type AggregateGroup,
  type Attribute,
  type Block,
  type BlockData,
  type BlockStatus,
  type Filter,
  type Item,
  type ItemBinding,
  type LinkedItem,
  type Measure,
  type SetBinding,
  type Subject,
  type ViewData,
} from '@16bit/core'
import { sql, type Transaction } from 'kysely'
import { checkHub } from './access.ts'
import { aggregate } from './aggregate.ts'
import type { Database } from './db/database.ts'
import { workspaceSeq } from './db/scope.ts'
import { HttpError, sqlState } from './http.ts'
import { expandItem, folderDefinitions, getItem, queryItems } from './items.ts'
import { checkTimeZone, resolveReadFilters, Unresolved } from './read-operands.ts'
import { folderRef, readView, viewContext } from './views.ts'

// View data (M4-05, D83): `GET /v1/workspaces/:w/folders/:folderId/view/data`. Every data block
// of the folder's view (stored, or the default at version 0), read as the caller under row-level
// security in ONE read-only snapshot, so the page is consistent and carries one `seq` (D58, D79).
//
// - The tree's version must be the client's (`?version=`); a stored tree that moved answers 409
//   `stale` and the client reloads the view.
// - Blocks `checkViewTree` finds broken (a removed or non-indexed attribute, a missing folder)
//   answer `invalid`; the rest of the page still renders (D79).
// - Item bindings resolve first: a fixed item (gone or hidden: `not_found`) or the first match of
//   a rule (none: the block shows its empty state). Then the blocks that name one with `$block`,
//   or a burndown's range; one that resolved to nothing makes them `unresolved` (D77).
// - Each block runs inside its own savepoint, so a block that fails (its statement timed out, an
//   operand it can't resolve) answers its own status and the others still run in the snapshot.
// - One deadline for the request (5 s): each block's statements get what is left of it as their
//   timeout, and blocks not reached in time answer `error: timeout`. At most 1,000 items in the
//   response: a block that would pass it answers `error: item_cap`.
// - Sets, boards and item reads go through `/query`'s code; numbers, charts and list group
//   measures through the aggregate engine (aggregate.ts), so every number is the one those
//   routes answer for the same binding.

type Trx = Transaction<Database>

export interface ViewDataOptions {
  /** The whole request's deadline (D83). Lowered in tests. */
  deadlineMs?: number
  /** Items per response. Lowered in tests. */
  maxItems?: number
}

export interface ViewDataRequest {
  folderId: string
  version: number
  blocks?: string[] | undefined
  tz?: string | undefined
}

class ItemCap extends Error {}

/** Everything one request's blocks share. */
interface Run {
  trx: Trx
  workspaceId: string
  me: Subject
  tz: string
  today: string
  /** Item each item-bound block resolved to; `null` for nothing. */
  items: Map<string, Item | null>
  /** Item-bound blocks whose fixed item is gone or hidden. */
  missing: Set<string>
  attributes: Map<string, readonly Attribute[]>
  itemsLeft: number
  deadline: number
}

const elapsedOut = (run: Run) => performance.now() >= run.deadline

async function attributesOf(run: Run, folderId: string): Promise<readonly Attribute[]> {
  const known = run.attributes.get(folderId)
  if (known) return known
  const attributes = (await folderDefinitions(run.trx, run.workspaceId, folderId)).map(
    (d) => d.attribute,
  )
  run.attributes.set(folderId, attributes)
  return attributes
}

/** `filters` with `$me`, `$now` and `$block` resolved (throws `Unresolved`). */
async function resolved(
  run: Run,
  folderId: string,
  filters: (Filter | undefined)[],
): Promise<(Filter | null)[]> {
  const blocks = new Map([...run.items].map(([id, item]) => [id, item?.id ?? null]))
  return resolveReadFilters(
    run.trx,
    await attributesOf(run, folderId),
    run.me.id,
    run.tz,
    filters.map((where, i) => ({ where, path: String(i) })),
    blocks,
  )
}

const both = (a: Filter | null | undefined, b: Filter): Filter => (a ? { and: [a, b] } : b)

/** Takes `n` items from the response's allowance, or throws `ItemCap`. */
function spend(run: Run, n: number) {
  if (n > run.itemsLeft) throw new ItemCap()
  run.itemsLeft -= n
}

/** Relation attributes among `fields`, at most 3 (`/query`'s expand cap). */
const relationFields = (attributes: readonly Attribute[], fields: readonly string[]) =>
  attributes
    .filter((a) => a.type === 'relation' && fields.includes(a.id))
    .slice(0, 3)
    .map((a) => a.id)

async function items(
  run: Run,
  binding: SetBinding,
  where: Filter | null,
  options: { limit: number; expand?: string[] },
) {
  const page = await queryItems(
    run.trx,
    run.workspaceId,
    run.me,
    {
      from: binding.folderId,
      where,
      sort: binding.sort,
      limit: options.limit,
      cursor: null,
      count: true,
      ...(options.expand && options.expand.length > 0 && { expand: options.expand }),
    },
    {},
  )
  spend(run, page.items.length)
  return page
}

async function aggregated(
  run: Run,
  from: string,
  where: Filter | null,
  measures: Measure[],
  groupBy?: { attribute: string; bucket?: 'day' | 'week' | 'month' | undefined },
) {
  const left = Math.max(1, Math.floor(run.deadline - performance.now()))
  return aggregate(
    run.trx,
    run.workspaceId,
    run.me,
    { from, where, measures, tz: run.tz, ...(groupBy && { groupBy }) },
    { timeoutMs: Math.min(AGGREGATE_TIMEOUT_MS, left) },
  )
}

/** Measures with their `where` resolved. */
async function measuresOf(run: Run, folderId: string, measures: readonly Measure[]) {
  const wheres = await resolved(
    run,
    folderId,
    measures.map((m) => m.where),
  )
  return measures.map((m, i) => {
    const where = wheres[i]
    return where ? { ...m, where } : { fn: m.fn, ...(m.attribute && { attribute: m.attribute }) }
  })
}

/** A date value as a calendar date in the request's zone. */
function calendarDay(value: unknown, tz: string): string | null {
  if (typeof value !== 'string') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

const DAY_MS = 86_400_000
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`)
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10)
const isWeekday = (t: number) => {
  const d = new Date(t).getUTCDay()
  return d !== 0 && d !== 6
}

/** The days from `start` to `end`, both included, as `days` counts them (D81), at most `cap`. */
function dayList(start: string, end: string, days: 'weekdays' | 'calendar', cap: number): string[] {
  const out: string[] = []
  for (let t = toTime(start); t <= toTime(end) && out.length < cap; t += DAY_MS) {
    if (days === 'calendar' || isWeekday(t)) out.push(toDay(t))
  }
  return out
}

/** Counted days from `start` to `end`, both included (D81). */
function countDays(start: string, end: string, days: 'weekdays' | 'calendar'): number {
  const a = toTime(start)
  const b = toTime(end)
  if (b < a) return 0
  const all = Math.round((b - a) / DAY_MS) + 1
  if (days === 'calendar') return all
  let n = Math.floor(all / 7) * 5
  for (let t = a + Math.floor(all / 7) * 7 * DAY_MS; t <= b; t += DAY_MS) if (isWeekday(t)) n++
  return n
}

const valueOf = (groups: AggregateGroup[], i = 0) => Number(groups[0]?.values[i] ?? 0)

async function linkedFor(
  run: Run,
  item: Item,
  expand: string[],
): Promise<Record<string, LinkedItem> | undefined> {
  if (expand.length === 0) return undefined
  const read = await expandItem(run.trx, run.workspaceId, run.me, item, expand, {})
  return read.linked
}

/** One data block's answer, run inside its savepoint. */
async function blockData(run: Run, block: Block): Promise<BlockData> {
  switch (block.type) {
    case 'table': {
      const { binding } = block.config
      const [where] = await resolved(run, binding.folderId, [binding.where])
      const page = await items(run, binding, where ?? null, { limit: binding.limit })
      return { kind: 'items', items: page.items, total: page.total ?? page.items.length }
    }
    case 'list': {
      const { binding, fields, groupBy } = block.config
      const attributes = await attributesOf(run, binding.folderId)
      const [where] = await resolved(run, binding.folderId, [binding.where])
      const expand = relationFields(
        attributes,
        fields.map((f) => f.attribute),
      )
      const page = await items(run, binding, where ?? null, { limit: binding.limit, expand })
      const data: BlockData = {
        kind: 'items',
        items: page.items,
        total: page.total ?? page.items.length,
        ...(page.linked && { linked: page.linked }),
      }
      if (groupBy && groupBy.measures.length > 0) {
        const measures = await measuresOf(run, binding.folderId, groupBy.measures)
        const result = await aggregated(run, binding.folderId, where ?? null, measures, {
          attribute: groupBy.attribute,
          bucket: groupBy.bucket,
        })
        data.groups = result.groups
      }
      return data
    }
    case 'board': {
      const { binding, column, fields } = block.config
      const attributes = await attributesOf(run, binding.folderId)
      const [where] = await resolved(run, binding.folderId, [binding.where])
      const expand = relationFields(
        attributes,
        fields.map((f) => f.attribute),
      )
      const columns: { option: string; items: Item[]; total: number }[] = []
      const linked: Record<string, LinkedItem> = {}
      for (const { option } of column.options) {
        const page = await items(
          run,
          binding,
          both(where, { attribute: column.attribute, op: 'eq', value: option }),
          { limit: binding.limit, expand },
        )
        Object.assign(linked, page.linked ?? {})
        columns.push({ option, items: page.items, total: page.total ?? page.items.length })
      }
      return { kind: 'board', columns, ...(expand.length > 0 && { linked }) }
    }
    case 'number': {
      const { config } = block
      if (config.kind === 'aggregate') {
        const { binding } = config
        const [where] = await resolved(run, binding.folderId, [binding.where])
        const measures = await measuresOf(
          run,
          binding.folderId,
          config.total ? [config.value, config.total] : [config.value],
        )
        const result = await aggregated(run, binding.folderId, where ?? null, measures)
        return { kind: 'aggregate', groups: result.groups, truncated: result.truncated }
      }
      const item = run.items.get(block.id) ?? null
      const start = calendarDay(item?.values[config.start], run.tz)
      const end = calendarDay(item?.values[config.end], run.tz)
      if (!start || !end) return { kind: 'days', day: null, of: null }
      const of = countDays(start, end, config.days)
      const inRange = run.today >= start && run.today <= end
      return { kind: 'days', day: inRange ? countDays(start, run.today, config.days) : null, of }
    }
    case 'chart': {
      const { config } = block
      const { binding } = config
      const [where] = await resolved(run, binding.folderId, [binding.where])
      if (config.kind === 'bars') {
        const measures = await measuresOf(run, binding.folderId, config.measures)
        const result = await aggregated(run, binding.folderId, where ?? null, measures, {
          attribute: config.groupBy.attribute,
          bucket: config.groupBy.bucket,
        })
        return { kind: 'aggregate', groups: result.groups, truncated: result.truncated }
      }
      // Burndown (D82): what remains of the set's total each day of the range block's item.
      const range = run.items.get(config.range.block) ?? null
      const start = calendarDay(range?.values[config.range.start], run.tz)
      const end = calendarDay(range?.values[config.range.end], run.tz)
      if (!range || !start || !end) throw new Unresolved([config.range.block])
      const measure: Measure = config.points
        ? { fn: 'sum', attribute: config.points }
        : { fn: 'count' }
      const total = valueOf(
        (await aggregated(run, binding.folderId, where ?? null, [measure])).groups,
      )
      const done = await aggregated(run, binding.folderId, where ?? null, [measure], {
        attribute: config.doneOn,
        bucket: 'day',
      })
      const doneOn = done.groups.flatMap((g) =>
        g.key.kind === 'value' && typeof g.key.value === 'string'
          ? [[g.key.value, Number(g.values[0] ?? 0)] as const]
          : [],
      )
      const days = dayList(start, end, config.days, MAX_DATE_BUCKETS).map((date) => {
        if (date > run.today) return { date, remaining: null }
        const doneBy = doneOn.reduce((n, [day, v]) => (day <= date ? n + v : n), 0)
        return { date, remaining: total - doneBy }
      })
      return { kind: 'burndown', start, end, today: run.today, total, days }
    }
    case 'fields': {
      const item = run.items.get(block.id) ?? null
      if (item) spend(run, 1)
      const expand = item
        ? relationFields(await attributesOf(run, item.folderId), block.config.fields)
        : []
      const linked = item ? await linkedFor(run, item, expand) : undefined
      return { kind: 'item', item, ...(linked && { linked }) }
    }
    default:
      throw new Error(`Not a data block: ${block.type}`)
  }
}

/** Resolves one item binding: the item, `null` for no match, or `missing` (`not_found`). */
async function resolveItem(run: Run, binding: ItemBinding): Promise<Item | null | 'missing'> {
  if (binding.by === 'item') {
    try {
      const item = await getItem(run.trx, run.workspaceId, binding.itemId)
      return item.folderId === binding.folderId ? item : 'missing'
    } catch (error) {
      if (error instanceof HttpError && error.code === 'not_found') return 'missing'
      throw error
    }
  }
  const attributes = await attributesOf(run, binding.folderId)
  const [where] = await resolveReadFilters(run.trx, attributes, run.me.id, run.tz, [
    { where: binding.where, path: 'where' },
  ])
  const page = await queryItems(
    run.trx,
    run.workspaceId,
    run.me,
    { from: binding.folderId, where: where ?? null, sort: binding.sort, limit: 1, cursor: null },
    {},
  )
  return page.items[0] ?? null
}

/** Runs `fn` in a savepoint, so a failure leaves the snapshot usable for the next block. */
async function isolated<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  await sql`SAVEPOINT view_block`.execute(trx)
  try {
    const value = await fn()
    await sql`RELEASE SAVEPOINT view_block`.execute(trx)
    return value
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT view_block`.execute(trx)
    throw error
  }
}

/** A failed block's status. */
function failed(error: unknown): BlockStatus {
  if (error instanceof Unresolved) return { status: 'unresolved', blocks: error.blocks }
  if (error instanceof ItemCap) return { status: 'error', error: 'item_cap' }
  if (sqlState(error) === '57014' || (error instanceof HttpError && error.code === 'timeout')) {
    return { status: 'error', error: 'timeout' }
  }
  if (error instanceof HttpError && error.code === 'not_found') return { status: 'not_found' }
  if (error instanceof HttpError && error.code === 'invalid_request') {
    return { status: 'invalid', errors: [{ path: '', message: error.message }] }
  }
  console.error(error)
  return { status: 'error', error: 'internal' }
}

/**
 * The folder's view data for `me`, in its snapshot transaction. 404 for a hidden or missing
 * folder, 409 `stale` past `version`, 422 for an unknown `tz`.
 */
export async function viewData(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  request: ViewDataRequest,
  options: ViewDataOptions = {},
): Promise<ViewData> {
  const started = performance.now()
  const folder = await folderRef(trx, workspaceId, request.folderId)
  await checkHub(trx, workspaceId, me, folder.hub_id, 'hub.read', 'Folder')
  const view = await readView(trx, workspaceId, folder)
  if (view.version !== request.version) {
    throw new HttpError('stale', 'The view has changed; reload it', { version: view.version })
  }
  const tz = request.tz ?? 'UTC'
  await checkTimeZone(trx, tz)
  const { rows: clock } = await sql<{ today: string; timeout: string }>`
    SELECT to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS today,
           current_setting('statement_timeout') AS timeout
  `.execute(trx)

  const tree = view.tree
  const errors = checkViewTree(tree, await viewContext(trx, workspaceId, folder.hub_id, tree))
  const invalid = new Map<string, { path: string; message: string }[]>()
  for (const { blockId, path, message } of errors) {
    invalid.set(blockId, [...(invalid.get(blockId) ?? []), { path, message }])
  }

  const run: Run = {
    trx,
    workspaceId,
    me,
    tz,
    today: clock[0]?.today ?? new Date().toISOString().slice(0, 10),
    items: new Map(),
    missing: new Set(),
    attributes: new Map(),
    itemsLeft: options.maxItems ?? MAX_VIEW_DATA_ITEMS,
    deadline: started + (options.deadlineMs ?? VIEW_DATA_DEADLINE_MS),
  }
  const limitStatements = () =>
    sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(run.deadline - performance.now())))}, true)`.execute(
      trx,
    )

  const dataBlocks = [...walkBlocks(tree.root)]
    .map(({ block }) => block)
    .filter((b) => BLOCK_TYPES[b.type].category === 'data')
  const wanted = request.blocks ? new Set(request.blocks) : null
  const answered = dataBlocks.filter((b) => !wanted || wanted.has(b.id))
  const blocks: Record<string, BlockStatus> = {}

  // Item bindings first (D83), each in its own savepoint. One that fails resolves to nothing.
  for (const block of dataBlocks) {
    if (bindingOf(block) !== 'item' || invalid.has(block.id)) continue
    if (elapsedOut(run)) break
    const binding = (block.config as { binding: ItemBinding }).binding
    await limitStatements()
    try {
      const item = await isolated(trx, () => resolveItem(run, binding))
      if (item === 'missing') {
        run.missing.add(block.id)
        run.items.set(block.id, null)
      } else {
        run.items.set(block.id, item)
      }
    } catch (error) {
      run.items.set(block.id, null)
      if (!wanted || wanted.has(block.id)) blocks[block.id] = failed(error)
    }
  }

  for (const block of answered) {
    if (blocks[block.id]) continue
    const broken = invalid.get(block.id)
    if (broken) {
      blocks[block.id] = { status: 'invalid', errors: broken }
      continue
    }
    if (run.missing.has(block.id)) {
      blocks[block.id] = { status: 'not_found' }
      continue
    }
    // Past the deadline first: an item binding the deadline cut off resolved to nothing, but
    // its dependents ran out of time, they didn't find nothing.
    if (elapsedOut(run)) {
      blocks[block.id] = { status: 'error', error: 'timeout' }
      continue
    }
    const unresolved = blockDependencies(block).filter(
      (id) => invalid.has(id) || !run.items.get(id),
    )
    if (unresolved.length > 0) {
      blocks[block.id] = { status: 'unresolved', blocks: unresolved }
      continue
    }
    await limitStatements()
    try {
      blocks[block.id] = { status: 'ok', data: await isolated(trx, () => blockData(run, block)) }
    } catch (error) {
      blocks[block.id] = failed(error)
    }
  }

  await sql`SELECT set_config('statement_timeout', ${clock[0]?.timeout ?? '0'}, true)`.execute(trx)
  return {
    folderId: folder.id,
    version: view.version,
    blocks,
    seq: await workspaceSeq(trx, workspaceId),
  }
}
