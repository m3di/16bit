import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  aggregateResultSchema,
  attributeTypes,
  hubDescriptionSchema,
  itemPageSchema,
  memberPageSchema,
  viewSchema,
  type AggregateGroup,
  type AggregateGroupKey,
  type Attribute,
  type Block,
  type Filter,
  type HubDescription,
  type Item,
  type Measure,
  type MeasureValue,
  type View,
} from '@16bit/core'
import { expect, type Page } from '@playwright/test'
import { type Client, expectStatus, listAll } from './roles.ts'

// The project hub `pnpm seed` adds to Pixel Works (apps/api/src/project-seed.ts, #257): Parcel
// Tracker, whose Home and My work root views are the two mockups (M4, D76 to D83). The IDs below
// are the seed's fixed ones.
//
// `expectViewMatches` checks what a page shows against the API: for every data block of the
// folder's stored view it asks `POST /aggregate` and `POST /query` for the block's own binding,
// as the same person and in the same time zone, and expects the block to show exactly that.

/** The fixed IDs of a project hub's folders and attributes (`projectIds` in project-seed.ts). */
export function projectHub(workspaceId: string, hubId: string) {
  const id = <T extends string>(name: T) => `${hubId}-${name}` as const
  return {
    workspaceId,
    hubId,
    folders: {
      home: id('home'),
      work: id('work'),
      backlog: id('backlog'),
      sprints: id('sprints'),
      epics: id('epics'),
    },
    attr: {
      title: id('title'),
      type: id('type'),
      stage: id('stage'),
      owner: id('owner'),
      reviewer: id('reviewer'),
      points: id('points'),
      sprint: id('sprint'),
      epic: id('epic'),
      doneOn: id('done-on'),
      bucket: id('bucket'),
      rank: id('rank'),
      start: id('start'),
      end: id('end'),
    },
  }
}
export type ProjectHub = ReturnType<typeof projectHub>

/** Parcel Tracker in Pixel Works, with the mockups' sample data (`pnpm seed`). */
export const PARCEL = projectHub('demo', 'parcel')
/** The same shape with 2,000 generated tasks in `large` (`pnpm seed:large --project`). */
export const SCALE = projectHub('large', 'scale')

/** The hub page, which opens on Home; a folder of it. */
export const parcelPath = (folderId?: string, hub: ProjectHub = PARCEL) =>
  `/w/${hub.workspaceId}/hubs/${hub.hubId}${folderId ? `/${folderId}` : ''}`

/** The project's people (PROJECT_PEOPLE in project-seed.ts), all editors of the hub. */
export const PARCEL_PEOPLE = {
  sara: 'Sara Lind',
  tomas: 'Tomas Berg',
} as const

/**
 * The secret of the hub's editor key, `qa-agent`, which `pnpm seed` writes to the gitignored
 * `e2e/.auth/parcel-agent-key.json` on the run that creates it (never to the repository).
 */
export function parcelAgentSecret(): string {
  const file = fileURLToPath(new URL('../../.auth/parcel-agent-key.json', import.meta.url))
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(
      `No ${file}. \`pnpm seed\` writes it on the run that creates the Parcel Tracker key; on a ` +
        'database seeded before that file existed, start from a fresh database.',
    )
  }
  return (JSON.parse(text) as { secret: string }).secret
}

/** The calendar day in `tz`, `YYYY-MM-DD`, as the server reads "today" for `$now` (D81). */
export const todayIn = (tz: string, at = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at)

// ----------------------------------------------------------------------------------------
// The API, as one person

/** What these helpers need of a client: `Client`, or `inWorkspace` for another workspace. */
export type Api = Pick<Client, 'get' | 'post' | 'put' | 'patch' | 'delete'>

/** `client` with paths under `/v1/workspaces/<workspaceId>` instead of `demo`. */
export function inWorkspace(client: Client, workspaceId: string): Api {
  const at = (p: string) =>
    p.startsWith('/v1/') ? p : `/v1/workspaces/${encodeURIComponent(workspaceId)}${p}`
  return {
    get: (p) => client.get(at(p)),
    post: (p, d) => client.post(at(p), d),
    put: (p, d) => client.put(at(p), d),
    patch: (p, d) => client.patch(at(p), d),
    delete: (p) => client.delete(at(p)),
  }
}

export async function getView(client: Api, folderId: string): Promise<View> {
  const res = await client.get(`/folders/${folderId}/view`)
  await expectStatus(res, 200)
  return viewSchema.parse(await res.json())
}

export async function describeHub(client: Api, hubId: string): Promise<HubDescription> {
  const res = await client.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  return hubDescriptionSchema.parse(await res.json())
}

export async function query(
  client: Api,
  body: { from: string; where?: Filter | undefined; sort?: unknown; limit: number; tz?: string },
): Promise<Item[]> {
  const res = await client.post('/query', body)
  await expectStatus(res, 200)
  return itemPageSchema.parse(await res.json()).items
}

export async function aggregate(
  client: Api,
  body: {
    from: string
    where?: Filter | undefined
    groupBy?: { attribute: string; bucket?: string | undefined } | undefined
    measures: Measure[]
    tz?: string
  },
): Promise<AggregateGroup[]> {
  const res = await client.post('/aggregate', body)
  await expectStatus(res, 200)
  return aggregateResultSchema.parse(await res.json()).groups
}

/** The current sprint as `$now` finds it in `tz`: the seeded Home's "sprint" rule. */
export async function currentSprint(
  client: Api,
  tz: string,
  hub: ProjectHub = PARCEL,
): Promise<Item> {
  const [sprint] = await query(client, {
    from: hub.folders.sprints,
    where: {
      and: [
        { attribute: hub.attr.start, op: 'lte', value: { $now: 'P0D' } },
        { attribute: hub.attr.end, op: 'gte', value: { $now: 'P0D' } },
      ],
    },
    sort: [{ attribute: hub.attr.start, direction: 'desc' }],
    limit: 1,
    tz,
  })
  if (!sprint) throw new Error('No current sprint: was `pnpm seed` run on this database?')
  return sprint
}

// ----------------------------------------------------------------------------------------
// Days (D81): weekdays, Monday to Friday

/** A stored date value as `YYYY-MM-DD`; empty for anything else. */
export const dateOf = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : '')

const DAY_MS = 86_400_000
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`)
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10)
const isWeekday = (t: number) => ![0, 6].includes(new Date(t).getUTCDay())

/** Weekdays from `start` to `end`, both included. */
export function weekdays(start: string, end: string): string[] {
  const out: string[] = []
  for (let t = toTime(start); t <= toTime(end); t += DAY_MS) if (isWeekday(t)) out.push(toDay(t))
  return out
}

/** "Day N of M" for `today` between two dates, as the `number` block's `days` kind counts. */
export function sprintDay(start: string, end: string, today: string) {
  const of = weekdays(start, end).length
  const day = today < start || today > end ? null : weekdays(start, today).length
  return { day, of }
}

/** `day` moved by `n` weekdays. */
export function addWeekdays(day: string, n: number): string {
  let t = toTime(day)
  let left = Math.abs(n)
  while (left > 0) {
    t += Math.sign(n) * DAY_MS
    if (isWeekday(t)) left--
  }
  return toDay(t)
}

// ----------------------------------------------------------------------------------------
// What a block shows, as text

/**
 * A data block as a person reads it. The page side is read from the DOM by `readBlock`; the
 * expected side is built from the API by `expectedBlock`. Text is whitespace-collapsed.
 */
export type Shown =
  | { state: string }
  | { state: 'ready'; number: { label: string; value: string } }
  | { state: 'ready'; fields: [string, string][] }
  | { state: 'ready'; groups: { label: string; measures: string; rows: string[] }[] }
  | { state: 'ready'; columns: { label: string; count: string; cards: string[] }[] }
  | { state: 'ready'; bars: string[] }
  | { state: 'ready'; burndown: { left: string[]; ideal: string[] } }

/** Reads one block of a rendered view, found by its block ID. */
export function readBlock(page: Page, blockId: string): Promise<Shown | null> {
  return page.evaluate((id) => {
    const t = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const el = document.querySelector(`[data-view-block="${CSS.escape(id)}"]`)
    if (!el) return null
    const state = el.getAttribute('data-block-state') ?? ''
    const kind = el.getAttribute('data-block')
    const inner = el.firstElementChild
    if (kind === 'number' && (state === 'ready' || state === 'empty')) {
      // A number's state text ("No value") is shown in place of its value.
      const [label, value] = [...(inner?.children ?? [])].map((c) => t(c))
      return {
        state: state === 'empty' ? 'ready' : state,
        number: { label: label ?? '', value: value ?? '' },
      }
    }
    if (state !== 'ready') return { state }
    if (kind === 'fields-block') {
      const terms = [...el.querySelectorAll('dt')].map((d) => t(d))
      const defs = [...el.querySelectorAll('dd')].map((d) => t(d))
      return { state, fields: terms.map((term, i) => [term, defs[i] ?? '']) }
    }
    if (kind === 'list') {
      const groups = [...(inner?.children ?? [])].map((g) => {
        const h = g.querySelector(':scope > h3')
        return {
          label: t(h?.children[0]),
          measures: t(h?.children[1]),
          rows: [...g.querySelectorAll(':scope > ul > li')].map((li) => t(li)),
        }
      })
      return { state, groups }
    }
    if (kind === 'board') {
      const columns = [...el.querySelectorAll('[data-block="board-column"]')].map((c) => {
        const h = c.querySelector('h3')
        return {
          label: t(h?.children[1]),
          count: t(h?.children[2]),
          cards: [...c.querySelectorAll('[data-block="board-card"]')].map((card) =>
            [t(card.children[0]), t(card.children[1])].filter(Boolean).join(' | '),
          ),
        }
      })
      return { state, columns }
    }
    if (kind === 'chart' && el.getAttribute('data-chart') === 'bars') {
      return { state, bars: [...el.querySelectorAll('li')].map((li) => t(li)) }
    }
    if (kind === 'chart') {
      const rows = [...el.querySelectorAll('table tbody tr')]
      return {
        state,
        burndown: {
          left: rows.map((r) => t(r.querySelectorAll('td')[0])),
          ideal: rows.map((r) => t(r.querySelectorAll('td')[1])),
        },
      }
    }
    return { state }
  }, blockId)
}

// ----------------------------------------------------------------------------------------
// What a block should show, from the API

const number = new Intl.NumberFormat('en')
const dateOnly = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })
const formatNumber = (n: number) => number.format(n)
const formatDate = (day: string) => dateOnly.format(new Date(`${day}T00:00:00Z`))
const formatPoints = (n: number) => String(Math.round(n * 10) / 10)
const isEmpty = (v: unknown) =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0)

/** Every block of a tree, depth first. */
export function walk(block: Block): Block[] {
  return [block, ...(block.children ?? []).flatMap(walk)]
}

const DATA = new Set(['table', 'list', 'board', 'number', 'chart', 'fields'])
export const dataBlocks = (root: Block) => walk(root).filter((b) => DATA.has(b.type))

interface Context {
  client: Api
  tz: string
  today: string
  description: HubDescription
  actor: (id: string) => string
  item: (id: string) => Promise<string>
  /** Item-bound blocks, resolved: the item, or null when the rule found none. */
  resolved: Map<string, Item | null>
}

/** `{ "$block": id }` replaced by the item that block resolved to. Null if one resolved to none. */
function substitute(filter: Filter | undefined, ctx: Context): Filter | undefined | null {
  const found = { unresolved: false }
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit)
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>
      if (typeof r['$block'] === 'string') {
        const item = ctx.resolved.get(r['$block'])
        if (!item) found.unresolved = true
        return item?.id ?? null
      }
      return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, visit(x)]))
    }
    return v
  }
  const out = filter === undefined ? undefined : (visit(filter) as Filter)
  return found.unresolved ? null : out
}

const both = (where: Filter | undefined, condition: Filter): Filter =>
  where ? { and: [where, condition] } : condition

function attributeOf(ctx: Context, id: string): Attribute {
  const a = ctx.description.attributes.find((x) => x.id === id)
  if (!a) throw new Error(`No attribute ${id} in ${ctx.description.hub.id}`)
  return a
}

function titleOf(ctx: Context, item: Item): string {
  const id = ctx.description.hub.titleAttributeId
  const v = id ? item.values[id] : undefined
  return (
    (typeof v === 'string' && v.trim()) || `${ctx.description.hub.idPrefix}-${String(item.seqId)}`
  )
}

/** A value as rows, cards and fields show it (format.ts `fieldValue`). */
async function display(
  ctx: Context,
  a: Attribute,
  value: unknown,
  emptyText?: string,
): Promise<string | undefined> {
  if (isEmpty(value)) return emptyText
  const list = Array.isArray(value) ? value.map(String) : []
  switch (a.type) {
    case 'select':
      return attributeTypes.select.render(value as string, a.config)
    case 'actor':
      return list.map(ctx.actor).join(', ')
    case 'relation':
      return (await Promise.all(list.map(ctx.item))).join(', ')
    case 'date':
      return formatDate(String(value).slice(0, 10))
    case 'number':
      return attributeTypes.number.render(value as number, a.config)
    case 'text':
      return attributeTypes.text.render(value as string, a.config)
    default:
      return String(value)
  }
}

function groupLabel(ctx: Context, key: AggregateGroupKey, a: Attribute): string {
  switch (key.kind) {
    case 'all':
      return ''
    case 'empty':
      return `No ${a.name.toLowerCase()}`
    case 'no_access':
      return 'Items you cannot see'
    case 'other':
      return 'Other'
    case 'value':
      if (key.label) return key.label
      if (a.type === 'actor') return ctx.actor(String(key.value))
      if (a.type === 'select') return attributeTypes.select.render(String(key.value), a.config)
      return String(key.value)
  }
}

function inGroup(item: Item, key: AggregateGroupKey, a: Attribute): boolean {
  const v = item.values[a.id]
  if (key.kind === 'empty') return isEmpty(v)
  if (key.kind !== 'value') return key.kind === 'all'
  return Array.isArray(v) ? v.map(String).includes(String(key.value)) : v === key.value
}

/** A group measure as the list's group header says it (format.ts `measureText`). */
function measureText(ctx: Context, m: Measure, value: MeasureValue | undefined): string {
  const name = m.attribute ? attributeOf(ctx, m.attribute).name.toLowerCase() : ''
  if (value === null || value === undefined) {
    return m.fn === 'sum' || m.fn === 'avg' ? `No ${name}` : ''
  }
  if (typeof value === 'string') return value
  const n = formatNumber(value)
  const words: Partial<Record<Measure['fn'], string>> = {
    count: `${n} ${value === 1 ? 'item' : 'items'}`,
    count_empty: `${n} without ${name}`,
    count_not_empty: `${n} with ${name}`,
    sum: `${n} ${name}`,
  }
  return words[m.fn] ?? n
}

/** A row of a list (GroupedList): the summary look or the table look. */
async function listRow(
  ctx: Context,
  item: Item,
  fields: { attribute: string; emptyText?: string | undefined }[],
  variant: 'summary' | 'table',
): Promise<string> {
  const title = titleOf(ctx, item)
  const values = await Promise.all(
    fields.map(async (f) => {
      const a = attributeOf(ctx, f.attribute)
      return { label: a.name, text: await display(ctx, a, item.values[a.id], f.emptyText) }
    }),
  )
  const shown = values.filter((v) => v.text !== undefined && v.text !== '')
  if (variant === 'summary') return `${title}, ${shown.map((v) => v.text).join(', ')}`.trim()
  return title + shown.map((v) => `, ${v.label} ${v.text ?? ''}`).join('')
}

/** The day "left" and "ideal" columns of the burndown's data table (ui/burndown.ts). */
function burndownColumns(
  start: string,
  end: string,
  today: string,
  total: number,
  doneOn: { day: string; points: number }[],
) {
  const days = weekdays(start, end)
  const n = days.length
  // The server's "remaining" per day up to today, turned back into points done per day.
  const doneBy = (day: string) =>
    doneOn.filter((d) => d.day <= day).reduce((sum, d) => sum + d.points, 0)
  const perDay = new Map<string, number>()
  let before = total
  for (const day of days) {
    if (day > today) break
    const remaining = total - doneBy(day)
    if (before - remaining !== 0) perDay.set(day, before - remaining)
    before = remaining
  }
  const left = (until: string, inclusive: boolean) =>
    Math.max(
      0,
      total -
        [...perDay]
          .filter(([d]) => d < until || (inclusive && d === until))
          .reduce((s, [, p]) => s + p, 0),
    )
  let actual: number[] = []
  if (today >= start && today > end) {
    actual = [...days.map((d) => left(d, false)), left(end, true)]
  } else if (today >= start) {
    let t = 0
    for (let i = 0; i < n; i++) if ((days[i] ?? '') <= today) t = i
    actual = [...days.slice(0, t).map((d) => left(d, false)), left(today, true)]
  }
  const ideal = Array.from({ length: n + 1 }, (_, i) => (n === 0 ? 0 : total * (1 - i / n)))
  const leftColumn = days.map((_, i) =>
    i < actual.length ? formatPoints(actual[i] ?? 0) : 'Not yet',
  )
  const idealColumn = days.map((_, i) => formatPoints(ideal[i] ?? 0))
  if (actual.length > n) {
    leftColumn.push(formatPoints(actual[n] ?? 0))
    idealColumn.push('0')
  }
  return { left: leftColumn, ideal: idealColumn }
}

/** What a data block should show, asked from the API for its own binding. */
async function expectedBlock(ctx: Context, block: Block): Promise<Shown> {
  const { client, tz } = ctx
  switch (block.type) {
    case 'fields': {
      const item = ctx.resolved.get(block.id)
      if (!item) return { state: 'unresolved' }
      const fields: [string, string][] = []
      for (const id of block.config.fields) {
        const a = attributeOf(ctx, id)
        fields.push([a.name, (await display(ctx, a, item.values[id])) ?? 'Empty'])
      }
      return { state: 'ready', fields }
    }
    case 'number': {
      const c = block.config
      const label = c.label ?? (c.kind === 'days' ? 'Day' : 'Items')
      if (c.kind === 'days') {
        const item = ctx.resolved.get(block.id)
        if (!item) return { state: 'unresolved' }
        const start = item.values[c.start]
        const end = item.values[c.end]
        if (typeof start !== 'string' || typeof end !== 'string') {
          return { state: 'ready', number: { label, value: 'No dates' } }
        }
        const { day, of } = sprintDay(start.slice(0, 10), end.slice(0, 10), ctx.today)
        const value =
          day === null ? 'Outside its dates' : `${formatNumber(day)} of ${formatNumber(of)}`
        return { state: 'ready', number: { label, value } }
      }
      const where = substitute(c.binding.where, ctx)
      if (where === null) return { state: 'unresolved' }
      const measures = [c.value, ...(c.total ? [c.total] : [])]
      const [group] = await aggregate(client, { from: c.binding.folderId, where, measures, tz })
      const text = (v: MeasureValue | undefined) =>
        typeof v === 'number' ? formatNumber(v) : typeof v === 'string' ? formatDate(v) : ''
      const value = text(group?.values[0])
      if (value === '') return { state: 'ready', number: { label, value: 'No value' } }
      const of = c.total ? text(group?.values[1]) : ''
      return { state: 'ready', number: { label, value: of ? `${value} of ${of}` : value } }
    }
    case 'chart': {
      const c = block.config
      const where = substitute(c.binding.where, ctx)
      if (where === null) return { state: 'unresolved' }
      if (c.kind === 'bars') {
        const a = attributeOf(ctx, c.groupBy.attribute)
        if (a.type === 'actor') throw new Error('Bars grouped by a person are not read here')
        const groups = await aggregate(client, {
          from: c.binding.folderId,
          where,
          groupBy: c.groupBy,
          measures: c.measures,
          tz,
        })
        const words = (v: MeasureValue | undefined) =>
          typeof v === 'number' ? formatNumber(v) : '—'
        const bars = groups.map((g) => {
          const text =
            c.measures.length > 1
              ? `${words(g.values[0])} of ${words(g.values[1])}`
              : words(g.values[0])
          return `${groupLabel(ctx, g.key, a)}: ${text}`
        })
        return { state: 'ready', bars }
      }
      const range = ctx.resolved.get(c.range.block)
      if (!range) return { state: 'unresolved' }
      const start = dateOf(range.values[c.range.start])
      const end = dateOf(range.values[c.range.end])
      const items = await query(client, { from: c.binding.folderId, where, limit: 200, tz })
      const weight = (i: Item) => (c.points ? Number(i.values[c.points] ?? 0) : 1)
      const total = items.reduce((s, i) => s + weight(i), 0)
      if (total === 0) return { state: 'ready', burndown: { left: [], ideal: [] } }
      const done = items.flatMap((i) => {
        const d = i.values[c.doneOn]
        return typeof d === 'string' ? [{ day: d.slice(0, 10), points: weight(i) }] : []
      })
      return { state: 'ready', burndown: burndownColumns(start, end, ctx.today, total, done) }
    }
    case 'list': {
      const c = block.config
      const where = substitute(c.binding.where, ctx)
      if (where === null) return { state: 'unresolved' }
      const items = await query(client, {
        from: c.binding.folderId,
        where,
        sort: c.binding.sort,
        limit: c.binding.limit,
        tz,
      })
      const leads = c.fields.some((f) => attributeOf(ctx, f.attribute).type === 'auto_id')
      const variant = c.groupBy || leads ? 'table' : 'summary'
      const row = (i: Item) => listRow(ctx, i, c.fields, variant)
      if (!c.groupBy) {
        return {
          state: 'ready',
          groups: [{ label: '', measures: '', rows: await Promise.all(items.map(row)) }],
        }
      }
      const a = attributeOf(ctx, c.groupBy.attribute)
      const measures = c.groupBy.measures
      const groups = await aggregate(client, {
        from: c.binding.folderId,
        where,
        groupBy: { attribute: c.groupBy.attribute, bucket: c.groupBy.bucket },
        measures: measures.length > 0 ? measures : [{ fn: 'count' }],
        tz,
      })
      return {
        state: 'ready',
        groups: await Promise.all(
          groups.map(async (g) => ({
            label: groupLabel(ctx, g.key, a),
            measures: measures
              .map((m, j) => measureText(ctx, m, g.values[j]))
              .filter(Boolean)
              .join(', '),
            rows: await Promise.all(items.filter((i) => inGroup(i, g.key, a)).map(row)),
          })),
        ),
      }
    }
    case 'board': {
      const c = block.config
      const where = substitute(c.binding.where, ctx)
      if (where === null) return { state: 'unresolved' }
      const a = attributeOf(ctx, c.column.attribute)
      const counts = await aggregate(client, {
        from: c.binding.folderId,
        where,
        groupBy: { attribute: a.id },
        measures: [{ fn: 'count' }],
        tz,
      })
      const countOf = (option: string) =>
        Number(counts.find((g) => g.key.kind === 'value' && g.key.value === option)?.values[0] ?? 0)
      const columns = []
      for (const col of c.column.options) {
        const items = await query(client, {
          from: c.binding.folderId,
          where: both(where, { attribute: a.id, op: 'eq', value: col.option }),
          sort: c.binding.sort,
          limit: c.binding.limit,
          tz,
        })
        const cards = await Promise.all(
          items.map(async (i) => {
            const values = await Promise.all(
              c.fields.map((f) =>
                display(ctx, attributeOf(ctx, f.attribute), i.values[f.attribute], f.emptyText),
              ),
            )
            const fields = values.filter((v) => v !== undefined && v !== '').join(', ')
            return [titleOf(ctx, i), fields].filter(Boolean).join(' | ')
          }),
        )
        columns.push({
          label:
            a.type === 'select' ? attributeTypes.select.render(col.option, a.config) : col.option,
          count: countOf(col.option).toLocaleString('en-US'),
          cards,
        })
      }
      return { state: 'ready', columns }
    }
    case 'table':
      throw new Error('The table block is the default view; this suite reads it elsewhere')
    default:
      throw new Error(`${block.type} is not a data block`)
  }
}

/** Everything the expected side needs, read once per check as `client` in `tz`. */
async function context(client: Api, hubId: string, tz: string, root: Block): Promise<Context> {
  const [description, members] = await Promise.all([
    describeHub(client, hubId),
    listAll(client as Client, '/members', memberPageSchema),
  ])
  const names = new Map(members.map((m) => [m.id, m.name]))
  const titles = new Map<string, Promise<string>>()
  const ctx: Context = {
    client,
    tz,
    today: todayIn(tz),
    description,
    actor: (id) => names.get(id) ?? id,
    item: (id) => {
      let title = titles.get(id)
      if (!title) {
        title = (async () => {
          const res = await client.get(`/items/${encodeURIComponent(id)}`)
          if (res.status() !== 200) return 'Linked item'
          return titleOf(ctx, (await res.json()) as Item)
        })()
        titles.set(id, title)
      }
      return title
    },
    resolved: new Map(),
  }
  // Item bindings first, as view data resolves them (D83), then `$block` reads them.
  for (const block of walk(root)) {
    const binding =
      block.type === 'fields' || (block.type === 'number' && block.config.kind === 'days')
        ? block.config.binding
        : null
    if (!binding || !('by' in binding)) continue
    if (binding.by === 'item') {
      const res = await client.get(`/items/${encodeURIComponent(binding.itemId)}`)
      ctx.resolved.set(block.id, res.status() === 200 ? ((await res.json()) as Item) : null)
    } else {
      const where = substitute(binding.where, ctx)
      const [item] =
        where === null
          ? []
          : await query(client, {
              from: binding.folderId,
              where,
              sort: binding.sort,
              limit: 1,
              tz,
            })
      ctx.resolved.set(block.id, item ?? null)
    }
  }
  return ctx
}

/** Each data block of `root` with what it should show, as `client` sees it in `tz`. */
export async function expectedView(
  client: Api,
  hubId: string,
  root: Block,
  tz: string,
): Promise<Map<string, Shown>> {
  const ctx = await context(client, hubId, tz, root)
  const out = new Map<string, Shown>()
  for (const block of dataBlocks(root)) out.set(block.id, await expectedBlock(ctx, block))
  return out
}

/**
 * Every data block of `folderId`'s view shows what the API answers for its binding, as
 * `client` (the person signed in on `page`) in `tz`. Waits up to `timeout` ms for each, all
 * counted from `since`, so a live update must land within it.
 */
export async function expectViewMatches(
  page: Page,
  client: Api,
  folderId: string,
  options: {
    hubId?: string
    tz?: string
    timeout?: number
    /** When the timeout starts (`Date.now()` of a write); the call by default. */
    since?: number
    only?: string[]
  } = {},
): Promise<Map<string, Shown>> {
  const started = options.since ?? Date.now()
  const { hubId = PARCEL.hubId, tz = 'UTC', timeout = 5_000 } = options
  const view = await getView(client, folderId)
  const expected = await expectedView(client, hubId, view.tree.root, tz)
  for (const [id, shown] of expected) {
    if (options.only && !options.only.includes(id)) continue
    const left = Math.max(1, timeout - (Date.now() - started))
    await expect
      .poll(() => readBlock(page, id), { timeout: left, message: `block "${id}"` })
      .toEqual(shown)
  }
  return expected
}
