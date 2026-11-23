import { z } from 'zod'
import {
  checkFilter,
  checkGroupBy,
  checkMeasure,
  DATE_BUCKETS,
  MAX_AGGREGATE_CONDITIONS,
  measureSchema,
  type Measure,
} from './aggregate.ts'
import { idSchema, timestampSchema, type Attribute } from './entities.ts'
import { hasNul, noNul, NUL_MESSAGE } from './nul.ts'
import { blockReferences, checkFilterOperands, countConditions } from './operands.ts'
import {
  boundedFilterSchema,
  compileItemQuery,
  sortSchema,
  type Filter,
  type QueryError,
} from './query.ts'

// Root views (D14 to D18, D76 to D79): one view per folder, a tree of blocks stored as one JSONB
// document `{ schemaVersion, root }` with its own version. `parseViewTree` reads any stored or
// sent tree: it upgrades old schema versions and checks the shape and the structural rules
// (block types, allowed children, caps, unique IDs, `$block` rules). `checkViewTree` checks a
// parsed tree against the hub's schema (folders, attributes, indexes). PUT needs both to pass;
// a stored tree that later fails `checkViewTree` (an attribute was removed) stays stored and
// its blocks answer `invalid` in view data.

/** The current `schemaVersion`. Older trees are upgraded on read by `parseViewTree`. */
export const VIEW_SCHEMA_VERSION = 1

export const MAX_VIEW_BLOCKS = 200
export const MAX_VIEW_DEPTH = 8
export const MAX_VIEW_DATA_BLOCKS = 20
/** The stored tree as JSON, in UTF-8 bytes (D76; also a CHECK on `view.tree`). */
export const MAX_VIEW_BYTES = 128 * 1024
/**
 * JSON nesting (objects and arrays) a tree may reach. A valid tree nests far less (8 block
 * levels at 2 each, plus a config with a 3-level filter); the cap keeps every scan of untrusted
 * input below it (size, NUL, the schema) from overflowing the stack (#285).
 */
export const MAX_VIEW_JSON_DEPTH = 64
export const MAX_COLUMNS = 4
/** Fields after the title on a list row or board card (D77). */
export const MAX_ROW_FIELDS = 4
export const MAX_GROUP_MEASURES = 2
export const MAX_BOARD_COLUMNS = 20
export const MAX_FIELDS_BLOCK_FIELDS = 20
/** Rows a `table` or `list` shows (D79). */
export const MAX_SET_ROWS = 100
/** Cards per board column (D79); more show as "+N more". */
export const MAX_BOARD_CARDS = 25

// ----------------------------------------------------------------------------------------
// Bindings (D79)

/**
 * A set of items: `POST /query`'s rules (indexed attributes, `MAX_FILTER_CONDITIONS`, depth,
 * `MAX_SORT_KEYS`), in a folder of the view's own hub. `where` may use `$me`, `$now` and
 * `$block`. `limit` is rows for a table or list, cards per column for a board; blocks that
 * only aggregate ignore it.
 */
export const setBindingSchema = z.strictObject({
  folderId: idSchema,
  where: boundedFilterSchema.optional(),
  sort: sortSchema.default([]),
  limit: z.int().min(1).max(MAX_SET_ROWS).default(50),
})
export type SetBinding = z.infer<typeof setBindingSchema>

/**
 * One item: a fixed item in a folder, or the first match of a rule. A fixed `itemId` resolves
 * only within `folderId` (a folder of the view's own hub, D79); an item that is elsewhere,
 * gone or hidden answers `not_found` in view data. A rule (`where` may use `$me` and
 * `$now`, never `$block`, D77). No match is not an error: the block shows its empty state and
 * blocks that name it with `$block` answer `unresolved`.
 */
export const itemBindingSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('item'), folderId: idSchema, itemId: idSchema }),
  z.strictObject({
    by: z.literal('rule'),
    folderId: idSchema,
    where: boundedFilterSchema,
    sort: sortSchema.default([]),
  }),
])
export type ItemBinding = z.infer<typeof itemBindingSchema>

export const BINDING_KINDS = ['none', 'set', 'item'] as const
export type BindingKind = (typeof BINDING_KINDS)[number]

// ----------------------------------------------------------------------------------------
// Block configs (D77)

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(...noNul)
const emptyTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(...noNul)
/** Weekdays (Monday to Friday, no holidays) or calendar days (D81). */
export const DAY_COUNTS = ['weekdays', 'calendar'] as const
const daysSchema = z.enum(DAY_COUNTS).default('weekdays')

/** An attribute shown after the title, with the text shown when it is empty ("No epic"). */
export const rowFieldSchema = z.strictObject({
  attribute: idSchema,
  emptyText: emptyTextSchema.optional(),
})
const rowFieldsSchema = z
  .array(rowFieldSchema)
  .max(MAX_ROW_FIELDS)
  .default([])
  .refine((fields) => new Set(fields.map((f) => f.attribute)).size === fields.length, {
    message: 'Each attribute is shown once',
  })

export const pageBlockConfigSchema = z.strictObject({ title: titleSchema.optional() })
export const sectionBlockConfigSchema = z.strictObject({ title: titleSchema.optional() })
/** Each child is one column, at most `MAX_COLUMNS`. */
export const columnsBlockConfigSchema = z.strictObject({})
export const headingBlockConfigSchema = z.strictObject({
  text: titleSchema,
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
})
/** Plain text. */
export const textBlockConfigSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    .refine(...noNul),
})

/** The default view's block: today's folder table (`ItemsBlock`). */
export const tableBlockConfigSchema = z.strictObject({ binding: setBindingSchema })

/**
 * Rows with up to 4 fields; optionally grouped by one attribute with up to 2 measures per
 * group ("Next up 19 points"). `create` shows "New item" (see `createPresets`).
 */
export const listBlockConfigSchema = z.strictObject({
  binding: setBindingSchema,
  fields: rowFieldsSchema,
  groupBy: z
    .strictObject({
      attribute: idSchema,
      bucket: z.enum(DATE_BUCKETS).optional(),
      measures: z.array(measureSchema).max(MAX_GROUP_MEASURES).default([]),
    })
    .optional(),
  create: z.boolean().default(false),
})

/**
 * Columns are an ordered subset of a select's options, empty columns included, each with an
 * optional `emptyText`, else the board's ("Nothing of yours is in review."). `binding.limit` is
 * cards per column, at most `MAX_BOARD_CARDS`.
 */
export const boardBlockConfigSchema = z.strictObject({
  binding: setBindingSchema.extend({
    limit: z.int().min(1).max(MAX_BOARD_CARDS).default(MAX_BOARD_CARDS),
  }),
  column: z.strictObject({
    attribute: idSchema,
    options: z
      .array(z.strictObject({ option: idSchema, emptyText: emptyTextSchema.optional() }))
      .min(1)
      .max(MAX_BOARD_COLUMNS)
      .refine((o) => new Set(o.map((c) => c.option)).size === o.length, {
        message: 'Each option is one column',
      }),
  }),
  emptyText: emptyTextSchema.optional(),
  fields: rowFieldsSchema,
  create: z.boolean().default(false),
})

/**
 * `aggregate`: one measure over a set, optionally "of" a second ("16 of 34").
 * `days`: the bound item's day between two of its dates ("day 6 of 10"), in the request's
 * time zone (D81).
 */
export const numberBlockConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('aggregate'),
    label: titleSchema.optional(),
    binding: setBindingSchema,
    value: measureSchema,
    total: measureSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('days'),
    label: titleSchema.optional(),
    binding: itemBindingSchema,
    start: idSchema,
    end: idSchema,
    days: daysSchema,
  }),
])

/**
 * `bars`: one bar row per group with 1 or 2 measures ("11 of 12" per epic). `burndown`: the
 * set's total `points` (or item count) minus the cumulative amount done per day, by `doneOn`,
 * across the dates `start` to `end` of the item that block `range.block` resolved to (D82).
 */
export const chartBlockConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('bars'),
    label: titleSchema.optional(),
    binding: setBindingSchema,
    groupBy: z.strictObject({ attribute: idSchema, bucket: z.enum(DATE_BUCKETS).optional() }),
    measures: z.array(measureSchema).min(1).max(MAX_GROUP_MEASURES),
  }),
  z.strictObject({
    kind: z.literal('burndown'),
    label: titleSchema.optional(),
    binding: setBindingSchema,
    range: z.strictObject({ block: idSchema, start: idSchema, end: idSchema }),
    doneOn: idSchema,
    points: idSchema.optional(),
    days: daysSchema,
  }),
])

/** An item's attributes, inline ("Sprint 24 runs Nov 9 to Nov 20") or stacked. */
export const fieldsBlockConfigSchema = z.strictObject({
  binding: itemBindingSchema,
  fields: z
    .array(idSchema)
    .min(1)
    .max(MAX_FIELDS_BLOCK_FIELDS)
    .refine((f) => new Set(f).size === f.length, { message: 'Each attribute is shown once' }),
  layout: z.enum(['inline', 'stacked']).default('stacked'),
})

// ----------------------------------------------------------------------------------------
// The registry (D14, D77)

/** The block types M4 builds (D15 amended). */
export const BLOCK_TYPE_NAMES = [
  'page',
  'section',
  'columns',
  'heading',
  'text',
  'table',
  'list',
  'board',
  'number',
  'chart',
  'fields',
] as const
export type BlockTypeName = (typeof BLOCK_TYPE_NAMES)[number]

export const BLOCK_CATEGORIES = ['layout', 'content', 'data'] as const
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number]

const CONTENT = ['heading', 'text'] as const
const DATA = ['table', 'list', 'board', 'number', 'chart', 'fields'] as const

export interface BlockTypeDefinition<C extends z.ZodType = z.ZodType> {
  category: BlockCategory
  /** Child types this block allows, in no particular order. Empty for a leaf. */
  children: readonly BlockTypeName[]
  /** Only the root, and the root is always one (`page`). */
  root: boolean
  configSchema: C
  /** The binding kinds a config of this type can have; see `bindingOf`. */
  bindings: readonly BindingKind[]
}

/**
 * Every block type, with its category, allowed children, config schema and binding kinds.
 * The web app registers one component per name, as it does for attribute types. `page` is the
 * root only, so no tree can nest pages; every tree is finite, so it can never loop (D14).
 */
export const BLOCK_TYPES = {
  page: {
    category: 'layout',
    children: ['section', 'columns', ...CONTENT, ...DATA],
    root: true,
    configSchema: pageBlockConfigSchema,
    bindings: ['none'],
  },
  section: {
    category: 'layout',
    children: ['columns', ...CONTENT, ...DATA],
    root: false,
    configSchema: sectionBlockConfigSchema,
    bindings: ['none'],
  },
  columns: {
    category: 'layout',
    children: ['section', ...CONTENT, ...DATA],
    root: false,
    configSchema: columnsBlockConfigSchema,
    bindings: ['none'],
  },
  heading: {
    category: 'content',
    children: [],
    root: false,
    configSchema: headingBlockConfigSchema,
    bindings: ['none'],
  },
  text: {
    category: 'content',
    children: [],
    root: false,
    configSchema: textBlockConfigSchema,
    bindings: ['none'],
  },
  table: {
    category: 'data',
    children: [],
    root: false,
    configSchema: tableBlockConfigSchema,
    bindings: ['set'],
  },
  list: {
    category: 'data',
    children: [],
    root: false,
    configSchema: listBlockConfigSchema,
    bindings: ['set'],
  },
  board: {
    category: 'data',
    children: [],
    root: false,
    configSchema: boardBlockConfigSchema,
    bindings: ['set'],
  },
  number: {
    category: 'data',
    children: [],
    root: false,
    configSchema: numberBlockConfigSchema,
    bindings: ['set', 'item'],
  },
  chart: {
    category: 'data',
    children: [],
    root: false,
    configSchema: chartBlockConfigSchema,
    bindings: ['set'],
  },
  fields: {
    category: 'data',
    children: [],
    root: false,
    configSchema: fieldsBlockConfigSchema,
    bindings: ['item'],
  },
} as const satisfies { [T in BlockTypeName]: BlockTypeDefinition }

export type BlockConfig<T extends BlockTypeName> = z.output<(typeof BLOCK_TYPES)[T]['configSchema']>
export type BlockConfigInput<T extends BlockTypeName> = z.input<
  (typeof BLOCK_TYPES)[T]['configSchema']
>

/** A block: a stable ID unique in its tree, a type, its config, and children for layouts. */
export type Block = {
  [T in BlockTypeName]: { id: string; type: T; config: BlockConfig<T>; children?: Block[] }
}[BlockTypeName]
export type BlockInput = {
  [T in BlockTypeName]: {
    id: string
    type: T
    config: BlockConfigInput<T>
    children?: BlockInput[] | undefined
  }
}[BlockTypeName]

const blockVariant = <T extends BlockTypeName>(type: T) =>
  z.strictObject({
    id: idSchema,
    type: z.literal(type),
    config: BLOCK_TYPES[type].configSchema,
    get children() {
      return z.array(blockSchema).max(MAX_VIEW_BLOCKS).optional()
    },
  })

/** One block, its config checked by its type's schema. Structure is checked on the tree. */
export const blockSchema: z.ZodType<Block, BlockInput> = z.discriminatedUnion('type', [
  blockVariant('page'),
  blockVariant('section'),
  blockVariant('columns'),
  blockVariant('heading'),
  blockVariant('text'),
  blockVariant('table'),
  blockVariant('list'),
  blockVariant('board'),
  blockVariant('number'),
  blockVariant('chart'),
  blockVariant('fields'),
]) as unknown as z.ZodType<Block, BlockInput>

/** The binding kind of a block as configured. */
export function bindingOf(block: Block): BindingKind {
  switch (block.type) {
    case 'table':
    case 'list':
    case 'board':
    case 'chart':
      return 'set'
    case 'number':
      return block.config.kind === 'days' ? 'item' : 'set'
    case 'fields':
      return 'item'
    default:
      return 'none'
  }
}

/** Every block of a tree, depth first, with its path (`root.children.0` ...) and depth. */
export function* walkBlocks(
  root: Block,
  path = 'root',
  depth = 1,
): Generator<{ block: Block; path: string; depth: number; parent: Block | null }> {
  const visit = function* (
    block: Block,
    at: string,
    level: number,
    parent: Block | null,
  ): Generator<{ block: Block; path: string; depth: number; parent: Block | null }> {
    yield { block, path: at, depth: level, parent }
    for (const [i, child] of (block.children ?? []).entries()) {
      yield* visit(child, `${at}.children.${String(i)}`, level + 1, block)
    }
  }
  yield* visit(root, path, depth, null)
}

/**
 * The filters and measures of a data block, with their config paths and whether `$block` may
 * appear (everywhere but an item binding's rule, D77).
 */
export function blockFilters(block: Block): { where: Filter; path: string; blocks: boolean }[] {
  const out: { where: Filter; path: string; blocks: boolean }[] = []
  const add = (where: Filter | undefined, path: string, blocks: boolean) => {
    if (where) out.push({ where, path, blocks })
  }
  const measures = (list: readonly Measure[], path: string) => {
    for (const [i, m] of list.entries()) add(m.where, `${path}.${String(i)}.where`, true)
  }
  const c = block.config as Record<string, unknown>
  const binding = c['binding'] as SetBinding | ItemBinding | undefined
  if (binding && 'by' in binding) {
    if (binding.by === 'rule') add(binding.where, 'config.binding.where', false)
  } else if (binding) {
    add(binding.where, 'config.binding.where', true)
  }
  if (block.type === 'list' && block.config.groupBy) {
    measures(block.config.groupBy.measures, 'config.groupBy.measures')
  }
  if (block.type === 'number' && block.config.kind === 'aggregate') {
    add(block.config.value.where, 'config.value.where', true)
    add(block.config.total?.where, 'config.total.where', true)
  }
  if (block.type === 'chart' && block.config.kind === 'bars') {
    measures(block.config.measures, 'config.measures')
  }
  return out
}

/** Block IDs a block depends on through `$block` or a burndown's `range.block`. */
export function blockDependencies(block: Block): string[] {
  const ids = blockFilters(block).flatMap((f) => blockReferences(f.where))
  if (block.type === 'chart' && block.config.kind === 'burndown') ids.push(block.config.range.block)
  return [...new Set(ids)]
}

/** UTF-8 length of a string, without TextEncoder (core runs in Node and browsers alike). */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/**
 * The path (`root.children.0` ...) of the first object or array nested deeper than `max`, or
 * null. Iterative, so input of any depth is safe to check.
 */
export function jsonDepthPath(value: unknown, max: number = MAX_VIEW_JSON_DEPTH): string | null {
  const stack: { value: unknown; depth: number; path: string[] }[] = [{ value, depth: 0, path: [] }]
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { value: v, depth, path } = next
    if (typeof v !== 'object' || v === null) continue
    if (depth + 1 > max) return path.join('.')
    const entries = Array.isArray(v)
      ? v.map((child, i): [string, unknown] => [String(i), child])
      : Object.entries(v)
    for (const [key, child] of entries.reverse()) {
      stack.push({ value: child, depth: depth + 1, path: [...path, key] })
    }
  }
  return null
}

/** Thrown by `jsonbText` past `MAX_VIEW_JSON_DEPTH`. */
class TooDeep extends Error {}

/**
 * JSON as Postgres prints `jsonb`: a space after every `,` and `:` between members. Key order
 * differs from Postgres's, which leaves the length alone. Values JSON can't hold are dropped
 * as `JSON.stringify` drops them. Recursive, so it refuses to go past `MAX_VIEW_JSON_DEPTH`.
 */
function jsonbText(value: unknown, depth = 0): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (depth + 1 > MAX_VIEW_JSON_DEPTH) throw new TooDeep()
  if (Array.isArray(value)) {
    return `[${value.map((v) => jsonbText(v, depth + 1) ?? 'null').join(', ')}]`
  }
  const members: string[] = []
  for (const [k, v] of Object.entries(value)) {
    const text = jsonbText(v, depth + 1)
    if (text !== undefined) members.push(`${JSON.stringify(k)}: ${text}`)
  }
  return `{${members.join(', ')}}`
}

/**
 * The size `view.tree` counts against `MAX_VIEW_BYTES`: the UTF-8 length of the tree as
 * Postgres prints it, which the `view_tree_size` CHECK measures with `octet_length(tree::text)`.
 */
export function viewTreeBytes(tree: unknown): number {
  try {
    return utf8Length(jsonbText(tree) ?? '')
  } catch (error) {
    // Nested past `MAX_VIEW_JSON_DEPTH`: no tree that deep is stored, so it counts as too big.
    if (error instanceof TooDeep) return Number.POSITIVE_INFINITY
    throw error
  }
}

/** The structural rules of D14 and D77, on a tree whose blocks already parsed. */
function checkStructure(root: Block): QueryError[] {
  const errors: QueryError[] = []
  const ids = new Map<string, string>()
  const itemBound = new Set<string>()
  let blocks = 0
  let dataBlocks = 0
  if (root.type !== 'page') errors.push({ path: 'root.type', message: 'The root block is a page' })
  for (const { block, path, depth, parent } of walkBlocks(root)) {
    blocks++
    const def = BLOCK_TYPES[block.type]
    if (def.category === 'data') dataBlocks++
    if (bindingOf(block) === 'item') itemBound.add(block.id)
    const seen = ids.get(block.id)
    if (seen !== undefined) {
      errors.push({
        path: `${path}.id`,
        message: `Block ID "${block.id}" is already used at ${seen}`,
      })
    } else {
      ids.set(block.id, path)
    }
    if (depth > MAX_VIEW_DEPTH) {
      errors.push({ path, message: `Blocks nest at most ${String(MAX_VIEW_DEPTH)} levels deep` })
    }
    if (parent && def.root) {
      errors.push({ path: `${path}.type`, message: 'A page is only ever the root block' })
    } else if (parent) {
      const allowed: readonly string[] = BLOCK_TYPES[parent.type].children
      if (!allowed.includes(block.type)) {
        errors.push({
          path: `${path}.type`,
          message: `A ${parent.type} block cannot hold a ${block.type} block`,
        })
      }
    }
    const children = block.children ?? []
    if (block.type === 'columns' && children.length > MAX_COLUMNS) {
      errors.push({ path: `${path}.children`, message: `At most ${String(MAX_COLUMNS)} columns` })
    }
    if (def.children.length === 0 && children.length > 0) {
      errors.push({ path: `${path}.children`, message: `A ${block.type} block has no children` })
    }
  }
  if (blocks > MAX_VIEW_BLOCKS) {
    errors.push({ path: 'root', message: `A view has at most ${String(MAX_VIEW_BLOCKS)} blocks` })
  }
  if (dataBlocks > MAX_VIEW_DATA_BLOCKS) {
    errors.push({
      path: 'root',
      message: `A view has at most ${String(MAX_VIEW_DATA_BLOCKS)} data blocks`,
    })
  }

  // Operands: `$block` only outside item rules, naming an item-bound block of this view.
  for (const { block, path } of walkBlocks(root)) {
    const filters = blockFilters(block)
    for (const f of filters) {
      errors.push(...checkFilterOperands([], f.where, `${path}.${f.path}`, { blocks: f.blocks }))
      for (const ref of blockReferences(f.where)) {
        if (!itemBound.has(ref)) {
          errors.push({
            path: `${path}.${f.path}`,
            message: `$block "${ref}" must name an item-bound block of this view`,
          })
        }
      }
    }
    const total = filters.reduce((n, f) => n + countConditions(f.where), 0)
    if (total > MAX_AGGREGATE_CONDITIONS) {
      errors.push({
        path: `${path}.config`,
        message: `At most ${String(MAX_AGGREGATE_CONDITIONS)} conditions in one block`,
      })
    }
    if (block.type === 'chart' && block.config.kind === 'burndown') {
      if (!itemBound.has(block.config.range.block)) {
        errors.push({
          path: `${path}.config.range.block`,
          message: `"${block.config.range.block}" must name an item-bound block of this view`,
        })
      }
    }
  }
  return errors
}

/** A stored or sent tree (D76). `parseViewTree` reads it; this is its current shape. */
export const viewTreeSchema = z
  .strictObject({
    schemaVersion: z.literal(VIEW_SCHEMA_VERSION),
    root: blockSchema,
  })
  .superRefine((tree, ctx) => {
    for (const e of checkStructure(tree.root)) {
      ctx.addIssue({ code: 'custom', path: e.path.split('.'), message: e.message })
    }
  })
export type ViewTree = z.output<typeof viewTreeSchema>
export type ViewTreeInput = z.input<typeof viewTreeSchema>

/**
 * Upgrades from older schema versions, keyed by the version they upgrade from. Each returns the
 * next version's tree. Block config changes add one here, so stored views need no data
 * migration (D76). Empty while only version 1 exists.
 */
const UPGRADES: Record<number, (tree: Record<string, unknown>) => Record<string, unknown>> = {}

const issuePath = (path: readonly PropertyKey[]) => path.map(String).join('.')

export type ParseViewTreeResult = { ok: true; tree: ViewTree } | { ok: false; errors: QueryError[] }

/**
 * Reads a view tree: upgrades an older `schemaVersion` step by step, then checks the shape,
 * every block's config, the structure (root page, allowed children, unique IDs, caps) and the
 * `$block` rules. Used on every read of a stored tree and on PUT, which answers 422
 * `invalid_view` with these errors. Paths are like `root.children.0.config.binding.where`.
 * The returned tree, defaults filled in, is the form to store: it is within `MAX_VIEW_BYTES`
 * as the `view_tree_size` CHECK counts it, and holds no U+0000.
 */
export function parseViewTree(raw: unknown): ParseViewTreeResult {
  // First, so every scan after it (size, NUL, the schema) works on a bounded depth.
  const deep = jsonDepthPath(raw)
  if (deep !== null) {
    const message = `A view nests at most ${String(MAX_VIEW_JSON_DEPTH)} levels`
    return { ok: false, errors: [{ path: deep, message }] }
  }
  const tooBig = { path: '', message: `A view is at most ${String(MAX_VIEW_BYTES / 1024)} KiB` }
  // Before parsing, so an oversized body costs no more than this; and after, below.
  if (viewTreeBytes(raw) > MAX_VIEW_BYTES) return { ok: false, errors: [tooBig] }
  const nul = nulPath(raw, [])
  if (nul !== null) return { ok: false, errors: [{ path: nul, message: NUL_MESSAGE }] }
  let tree = raw
  if (typeof tree === 'object' && tree !== null && !Array.isArray(tree)) {
    let record = tree as Record<string, unknown>
    let version = record['schemaVersion']
    while (typeof version === 'number' && version < VIEW_SCHEMA_VERSION) {
      const upgrade = UPGRADES[version]
      if (!upgrade) break
      record = upgrade(record)
      version = record['schemaVersion']
    }
    tree = record
  }
  const parsed = viewTreeSchema.safeParse(tree)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message })),
    }
  }
  // The parsed tree, defaults filled in, is what is stored and what the `view_tree_size` CHECK
  // measures; defaults can push a tree just under the cap over it.
  if (viewTreeBytes(parsed.data) > MAX_VIEW_BYTES) return { ok: false, errors: [tooBig] }
  return { ok: true, tree: parsed.data }
}

/**
 * The path of the first string or key holding U+0000, which Postgres can't store in `jsonb`
 * (#221), or null. Covers every value of the tree, filter operands included.
 */
function nulPath(value: unknown, path: string[]): string | null {
  if (typeof value === 'string') return hasNul(value) ? path.join('.') : null
  if (typeof value !== 'object' || value === null) return null
  // `parseViewTree` refused deeper input already; never recurse past it.
  if (path.length >= MAX_VIEW_JSON_DEPTH) return null
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i): [string, unknown] => [String(i), v])
    : Object.entries(value)
  for (const [key, v] of entries) {
    if (hasNul(key)) return [...path, JSON.stringify(key)].join('.')
    const found = nulPath(v, [...path, key])
    if (found !== null) return found
  }
  return null
}

/**
 * The view a folder opens on without a stored one (D76): `page > table(this folder)`, which
 * looks like today's folder screen. A views-only folder holds no items, so its default is an
 * empty page, shown as "No view yet".
 */
export function defaultViewTree(folderId: string, options: { viewsOnly: boolean }): ViewTree {
  const children: Block[] = options.viewsOnly
    ? []
    : [
        {
          id: 'table',
          type: 'table',
          config: { binding: { folderId, sort: [], limit: 50 } },
        },
      ]
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    root: { id: 'page', type: 'page', config: {}, children },
  }
}

// ----------------------------------------------------------------------------------------
// Checking a tree against the hub's schema (D79)

/** What `checkViewTree` needs to know about the view's hub. */
export interface ViewSchemaContext {
  /**
   * Folders of the view's hub (the hub root included) the caller can read, each with the
   * attributes it shows. A folder outside the hub is simply not here.
   */
  folders: ReadonlyMap<string, { viewsOnly: boolean; attributes: readonly Attribute[] }>
}

/** A problem with one block. `path` is from the tree's root, as in `parseViewTree`. */
export interface ViewError extends QueryError {
  blockId: string
}

/**
 * Checks a parsed tree against the hub's schema: every binding names a folder of the hub that
 * holds items; filtered, sorted, grouped and summarised attributes are on that folder and
 * indexed, with each type's operators and summaries; shown fields are on the folder; a board's
 * column is a select with those options; dates are date attributes. PUT refuses a tree with any
 * error (422 `invalid_view`, under the hub's schema lock shared, D55); view data answers
 * `invalid` for exactly the blocks with errors.
 */
export function checkViewTree(tree: ViewTree, context: ViewSchemaContext): ViewError[] {
  const errors: ViewError[] = []
  const byId = new Map<string, Block>()
  for (const { block } of walkBlocks(tree.root)) byId.set(block.id, block)

  for (const { block, path } of walkBlocks(tree.root)) {
    const push = (list: readonly QueryError[], prefix = path) => {
      for (const e of list)
        errors.push({ blockId: block.id, path: `${prefix}.${e.path}`, message: e.message })
    }
    const folder = (folderId: string, at: string) => {
      const f = context.folders.get(folderId)
      if (!f) {
        push([{ path: at, message: `Folder "${folderId}" is not a folder of this hub` }])
        return null
      }
      if (f.viewsOnly) {
        push([{ path: at, message: `Folder "${folderId}" is views only and holds no items` }])
        return null
      }
      return f.attributes
    }
    const attribute = (
      attrs: readonly Attribute[],
      attributeId: string,
      at: string,
      need: { type?: Attribute['type']; indexed?: boolean } = {},
    ) => {
      const a = attrs.find((x) => x.id === attributeId)
      if (!a) {
        push([
          { path: at, message: `Attribute "${attributeId}" is not an attribute of this folder` },
        ])
      } else if (need.type && a.type !== need.type) {
        push([
          {
            path: at,
            message: `Attribute "${attributeId}" is a ${a.type} attribute, not ${need.type}`,
          },
        ])
      } else if (need.indexed && !a.indexed) {
        push([{ path: at, message: `Attribute "${attributeId}" is not indexed` }])
      } else {
        return a
      }
      return null
    }
    const sort = (attrs: readonly Attribute[], s: SetBinding['sort'], at: string) => {
      const compiled = compileItemQuery(attrs, { where: null, sort: s })
      if (!compiled.ok)
        push(
          compiled.errors.map((e) => ({ ...e, path: at + e.path.slice('sort'.length) })),
          `${path}.config.binding`,
        )
    }
    const fieldsOn = (attrs: readonly Attribute[], ids: readonly string[], at: string) => {
      for (const [i, id] of ids.entries()) attribute(attrs, id, `${at}.${String(i)}`)
    }

    const c = block.config as Record<string, unknown>
    const binding = c['binding'] as SetBinding | ItemBinding | undefined
    if (!binding) continue
    const attrs = folder(binding.folderId, 'config.binding.folderId')
    if (!attrs) continue
    for (const f of blockFilters(block)) {
      push(checkFilter(attrs, f.where, f.path, { blocks: f.blocks }))
    }
    if (!('by' in binding) || binding.by === 'rule') sort(attrs, binding.sort, 'sort')

    switch (block.type) {
      case 'list': {
        fieldsOn(
          attrs,
          block.config.fields.map((f) => f.attribute),
          'config.fields',
        )
        const g = block.config.groupBy
        if (g) {
          push(checkGroupBy(attrs, { attribute: g.attribute, bucket: g.bucket }, 'config.groupBy'))
          for (const [i, m] of g.measures.entries()) {
            push(
              checkMeasure(
                attrs,
                { ...m, where: undefined },
                `config.groupBy.measures.${String(i)}`,
                { blocks: true },
              ),
            )
          }
        }
        break
      }
      case 'board': {
        fieldsOn(
          attrs,
          block.config.fields.map((f) => f.attribute),
          'config.fields',
        )
        const a = attribute(attrs, block.config.column.attribute, 'config.column.attribute', {
          type: 'select',
          indexed: true,
        })
        if (a?.type === 'select') {
          const options = new Set(a.config.options.map((o) => o.id))
          for (const [i, col] of block.config.column.options.entries()) {
            if (!options.has(col.option)) {
              push([
                {
                  path: `config.column.options.${String(i)}.option`,
                  message: `"${col.option}" is not an option of "${a.id}"`,
                },
              ])
            }
          }
        }
        break
      }
      case 'number':
        if (block.config.kind === 'aggregate') {
          push(
            checkMeasure(attrs, { ...block.config.value, where: undefined }, 'config.value', {
              blocks: true,
            }),
          )
          if (block.config.total) {
            push(
              checkMeasure(attrs, { ...block.config.total, where: undefined }, 'config.total', {
                blocks: true,
              }),
            )
          }
        } else {
          attribute(attrs, block.config.start, 'config.start', { type: 'date' })
          attribute(attrs, block.config.end, 'config.end', { type: 'date' })
        }
        break
      case 'chart':
        if (block.config.kind === 'bars') {
          push(checkGroupBy(attrs, block.config.groupBy, 'config.groupBy'))
          for (const [i, m] of block.config.measures.entries()) {
            push(
              checkMeasure(attrs, { ...m, where: undefined }, `config.measures.${String(i)}`, {
                blocks: true,
              }),
            )
          }
        } else {
          attribute(attrs, block.config.doneOn, 'config.doneOn', { type: 'date', indexed: true })
          if (block.config.points) {
            attribute(attrs, block.config.points, 'config.points', {
              type: 'number',
              indexed: true,
            })
          }
          const range = byId.get(block.config.range.block)
          const rangeBinding = range && (range.config as Record<string, unknown>)['binding']
          const rangeFolder =
            rangeBinding && typeof rangeBinding === 'object' && 'folderId' in rangeBinding
              ? context.folders.get(String(rangeBinding.folderId))
              : undefined
          if (rangeFolder) {
            attribute(rangeFolder.attributes, block.config.range.start, 'config.range.start', {
              type: 'date',
            })
            attribute(rangeFolder.attributes, block.config.range.end, 'config.range.end', {
              type: 'date',
            })
          }
        }
        break
      case 'fields':
        fieldsOn(attrs, block.config.fields, 'config.fields')
        break
      default:
        break
    }
  }
  return errors
}

/**
 * The values "New item" in a `list` or `board` presets (D77): the group's or column's value,
 * plus each top-level `AND` equality of the binding's `where` (`eq`, or `in` with one value,
 * `$me` resolved to `me`). An `OR`, or a condition nested deeper, presets nothing. Values are
 * shaped for their type: list types (multi-select, actor, relation) get a list of one. The
 * server checks them as any create.
 */
export function createPresets(
  attributes: readonly Attribute[],
  where: Filter | undefined,
  me: string,
  group?: { attribute: string; value: string | number | boolean },
): Record<string, unknown> {
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const LIST = new Set(['multi_select', 'actor', 'relation'])
  const values: Record<string, unknown> = {}
  const set = (attributeId: string, value: unknown) => {
    const a = byId.get(attributeId)
    if (!a) return
    if (typeof value === 'object' && value !== null && '$me' in value) value = me
    if (typeof value === 'object' && value !== null) return
    values[attributeId] = LIST.has(a.type) ? [value] : value
  }
  const top = where ? ('and' in where ? where.and : 'op' in where ? [where] : []) : []
  for (const f of top) {
    if (!('op' in f)) continue
    if (f.op === 'eq') set(f.attribute, f.value)
    if (f.op === 'in' && Array.isArray(f.value) && f.value.length === 1)
      set(f.attribute, f.value[0])
  }
  if (group) set(group.attribute, group.value)
  return values
}

// ----------------------------------------------------------------------------------------
// The view routes (D76, D78)

/**
 * `GET /v1/workspaces/:workspaceId/folders/:folderId/view`, `hub.read`. The stored view, or
 * the default (`defaultViewTree`) with `stored: false`, `version: 0` and no `updatedAt` or
 * `updatedBy`. A hidden or missing folder is 404 (D45). PUT answers the same shape.
 */
export const viewSchema = z.strictObject({
  folderId: idSchema,
  hubId: idSchema,
  stored: z.boolean(),
  version: z.int().min(0),
  tree: viewTreeSchema,
  updatedAt: timestampSchema.nullable(),
  updatedBy: idSchema.nullable(),
  seq: z.int().min(0),
})
export type View = z.infer<typeof viewSchema>

/**
 * `PUT /v1/workspaces/:workspaceId/folders/:folderId/view`, `hub.manageSchema` (D78; agents
 * never, D28). Replaces the whole tree. `version` is the version the client last saw, `0` for
 * none stored. 409 `conflict` with `current` when it moved (including two first PUTs racing at
 * `version: 0`), 422 `invalid_view` with `errors` from `parseViewTree` or `checkViewTree`.
 * Sends the hub NOTIFY (D76).
 */
export const putViewSchema = z.strictObject({
  version: z.int().min(0),
  tree: z.unknown(),
})
export type PutView = z.infer<typeof putViewSchema>

/**
 * Query string of `DELETE /v1/workspaces/:workspaceId/folders/:folderId/view` (reset to the
 * default), `hub.manageSchema`. 204, or 409 `conflict` with `current` when `version` is stale.
 * No view stored is 404.
 */
export const deleteViewQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(1),
})

export const viewErrorSchema = z.strictObject({ path: z.string(), message: z.string() })

export const invalidViewErrorSchema = z.strictObject({
  error: z.literal('invalid_view'),
  message: z.string(),
  errors: z.array(viewErrorSchema),
})
export type InvalidViewError = z.infer<typeof invalidViewErrorSchema>

export const viewConflictErrorSchema = z.strictObject({
  error: z.literal('conflict'),
  message: z.string(),
  current: viewSchema,
})
export type ViewConflictError = z.infer<typeof viewConflictErrorSchema>
