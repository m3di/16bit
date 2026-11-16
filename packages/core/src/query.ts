import { z } from 'zod'
import {
  attributeTypes,
  FILTER_OPERATORS,
  TEXT_MAX_LENGTH,
  type AttributeType,
  type AttributeTypeName,
  type FilterOperator,
  type IndexProjection,
  type ItemValue,
} from './attribute-types/index.ts'
import { idSchema, type Attribute } from './entities.ts'

// The `where` and `sort` parts of the query shape in docs/ARCHITECTURE.md (D19, D20).
// Shape checks live in the schemas; `compileItemQuery` checks them against the folder's
// attributes: indexed only, each type's own operators, and operands valid for the type.

export const MAX_FILTER_CONDITIONS = 20
export const MAX_FILTER_DEPTH = 3
export const MAX_FILTER_IN_VALUES = 100
export const MAX_SORT_KEYS = 3

/**
 * One test on an indexed attribute. `value` depends on `op`: none for `is_empty` and
 * `is_not_empty`, an array for `in` and `not_in`, a single value otherwise.
 *
 * Semantics: `contains`, `not_contains` and `starts_with` ignore case; `eq` on text is exact.
 * The negative operators (`neq`, `not_contains`, `not_in`) also match items with no value.
 */
export interface FilterCondition {
  attribute: string
  op: FilterOperator
  value?: unknown
}
export type Filter = { and: Filter[] } | { or: Filter[] } | FilterCondition

export const filterConditionSchema = z.strictObject({
  attribute: idSchema,
  op: z.enum(FILTER_OPERATORS),
  value: z.unknown().optional(),
})

export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(filterSchema).max(MAX_FILTER_CONDITIONS) }),
    z.strictObject({ or: z.array(filterSchema).max(MAX_FILTER_CONDITIONS) }),
    filterConditionSchema,
  ]),
)

const isCondition = (f: Filter): f is FilterCondition => 'op' in f
const childrenOf = (f: Filter): Filter[] => ('and' in f ? f.and : 'or' in f ? f.or : [])

/** A filter tree with at most `MAX_FILTER_CONDITIONS` conditions, nested `MAX_FILTER_DEPTH` deep. */
export const boundedFilterSchema = filterSchema.superRefine((filter, ctx) => {
  let conditions = 0
  let depth = 0
  const walk = (f: Filter, level: number) => {
    depth = Math.max(depth, level)
    if (isCondition(f)) conditions++
    for (const child of childrenOf(f)) walk(child, level + 1)
  }
  walk(filter, 1)
  if (conditions > MAX_FILTER_CONDITIONS) {
    ctx.addIssue({
      code: 'custom',
      message: `At most ${String(MAX_FILTER_CONDITIONS)} conditions are allowed`,
    })
  }
  if (depth > MAX_FILTER_DEPTH) {
    ctx.addIssue({
      code: 'custom',
      message: `Filters nest at most ${String(MAX_FILTER_DEPTH)} levels deep`,
    })
  }
})

export const SORT_DIRECTIONS = ['asc', 'desc'] as const

/** Items with no value sort last in either direction. Ties end on the item ID. */
export const sortSchema = z
  .array(z.strictObject({ attribute: idSchema, direction: z.enum(SORT_DIRECTIONS).default('asc') }))
  .max(MAX_SORT_KEYS)
  .refine((keys) => new Set(keys.map((k) => k.attribute)).size === keys.length, {
    message: 'Each attribute can be sorted on once',
  })
export type Sort = z.input<typeof sortSchema>

/** A column of `item_index`. */
export type IndexColumn = Exclude<IndexProjection, 'none'>

/** A condition resolved to an `item_index` column, with operands already projected. */
export interface CompiledCondition {
  attributeId: string
  column: IndexColumn
  op: FilterOperator
  /** Projected operands: none for the empty checks, one or more otherwise. */
  operands: (number | string)[]
}
export type CompiledFilter =
  { and: CompiledFilter[] } | { or: CompiledFilter[] } | { condition: CompiledCondition }

/**
 * How to order one attribute: by the column itself, by its lower-cased text (text), or by
 * position in `order` (select option order; values not in it sort after every option).
 */
export interface CompiledSort {
  attributeId: string
  column: IndexColumn
  direction: (typeof SORT_DIRECTIONS)[number]
  key: { by: 'value' } | { by: 'lower' } | { by: 'position'; order: string[] }
}

export interface QueryError {
  /** Where in the request, for example `where.and.1` or `sort.0`. */
  path: string
  message: string
}

export type CompileItemQueryResult =
  | { ok: true; where: CompiledFilter | null; sort: CompiledSort[] }
  | { ok: false; errors: QueryError[] }

const TEXT_OPERATORS: readonly FilterOperator[] = ['contains', 'not_contains', 'starts_with']
const LIST_OPERATORS: readonly FilterOperator[] = ['in', 'not_in']
const EMPTY_CHECKS: readonly FilterOperator[] = ['is_empty', 'is_not_empty']

type Operand = { ok: true; value: number | string } | { ok: false; message: string }

function projectWith<C, V extends ItemValue>(
  type: AttributeType<AttributeTypeName, C, V>,
  config: C,
  input: unknown,
): Operand {
  const result = type.valueSchema(config).safeParse(input)
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'Invalid value' }
  }
  if (type.isEmpty(result.data, config)) {
    return { ok: false, message: 'An empty value matches nothing; use is_empty' }
  }
  // An operand is one value, or a list of one element, so it projects to exactly one.
  const [projected] = type.project(result.data, config)
  return projected === undefined
    ? { ok: false, message: 'Not filterable' }
    : { ok: true, value: projected }
}

/** Checks one operand with the type's own value schema and projects it like a stored value. */
function operand(attribute: Attribute, input: unknown): Operand {
  switch (attribute.type) {
    case 'text':
      return projectWith(attributeTypes.text, attribute.config, input)
    case 'number':
      // A filter bound may sit outside the attribute's min and max, so those are not applied.
      return projectWith(attributeTypes.number, { format: 'plain' }, input)
    case 'boolean':
      return projectWith(attributeTypes.boolean, attribute.config, input)
    case 'date':
      return projectWith(attributeTypes.date, attribute.config, input)
    case 'select':
      return projectWith(attributeTypes.select, attribute.config, input)
    // List types: an operand is one element, checked as a list of one.
    case 'multi_select':
      return projectWith(attributeTypes.multi_select, attribute.config, [input])
    case 'actor':
      return projectWith(attributeTypes.actor, attribute.config, [input])
    case 'relation':
      return projectWith(attributeTypes.relation, attribute.config, [input])
    case 'url':
      return projectWith(attributeTypes.url, attribute.config, input)
    case 'auto_id':
      return projectWith(attributeTypes.auto_id, attribute.config, input)
    case 'rich_text':
      // Only the text operators apply, and they take a search string, not a value.
      return { ok: false, message: 'Not comparable; use contains' }
  }
}

const searchTextSchema = z.string().min(1).max(TEXT_MAX_LENGTH)

function resolve(
  byId: ReadonlyMap<string, Attribute>,
  attributeId: string,
  path: string,
  errors: QueryError[],
): { attribute: Attribute; column: IndexColumn } | null {
  const attribute = byId.get(attributeId)
  if (!attribute) {
    errors.push({ path, message: `Attribute "${attributeId}" is not an attribute of this folder` })
    return null
  }
  if (!attribute.indexed) {
    errors.push({
      path,
      message: `Attribute "${attributeId}" is not indexed; only indexed attributes can be filtered or sorted`,
    })
    return null
  }
  const column = attributeTypes[attribute.type].indexProjection
  if (column === 'none') {
    errors.push({ path, message: `Attribute "${attributeId}" has a type that cannot be indexed` })
    return null
  }
  return { attribute, column }
}

function compileCondition(
  byId: ReadonlyMap<string, Attribute>,
  c: FilterCondition,
  path: string,
  errors: QueryError[],
): CompiledCondition | null {
  const resolved = resolve(byId, c.attribute, path, errors)
  if (!resolved) return null
  const { attribute, column } = resolved
  const supported = attributeTypes[attribute.type].filterOperators
  if (!supported.includes(c.op)) {
    errors.push({
      path,
      message: `Operator "${c.op}" is not supported on ${attribute.type} attribute "${attribute.id}"; use one of ${supported.join(', ')}`,
    })
    return null
  }
  const fail = (message: string) => {
    errors.push({ path: `${path}.value`, message: `${c.op} on "${attribute.id}": ${message}` })
    return null
  }

  if (EMPTY_CHECKS.includes(c.op)) {
    if (c.value !== undefined) return fail('takes no value')
    return { attributeId: attribute.id, column, op: c.op, operands: [] }
  }
  if (TEXT_OPERATORS.includes(c.op)) {
    const text = searchTextSchema.safeParse(c.value)
    if (!text.success) return fail('needs a non-empty string')
    return { attributeId: attribute.id, column, op: c.op, operands: [text.data] }
  }
  if (LIST_OPERATORS.includes(c.op)) {
    if (!Array.isArray(c.value) || c.value.length === 0) return fail('needs a non-empty array')
    if (c.value.length > MAX_FILTER_IN_VALUES) {
      return fail(`takes at most ${String(MAX_FILTER_IN_VALUES)} values`)
    }
    const operands: (number | string)[] = []
    for (const [i, input] of (c.value as unknown[]).entries()) {
      const result = operand(attribute, input)
      if (!result.ok) return fail(`value ${String(i)}: ${result.message}`)
      operands.push(result.value)
    }
    return { attributeId: attribute.id, column, op: c.op, operands }
  }
  if (c.value === undefined) return fail('needs a value')
  const result = operand(attribute, c.value)
  if (!result.ok) return fail(result.message)
  return { attributeId: attribute.id, column, op: c.op, operands: [result.value] }
}

function compileFilter(
  byId: ReadonlyMap<string, Attribute>,
  f: Filter,
  path: string,
  errors: QueryError[],
): CompiledFilter | null {
  if (isCondition(f)) {
    const condition = compileCondition(byId, f, path, errors)
    return condition && { condition }
  }
  const [kind, children] = 'and' in f ? (['and', f.and] as const) : (['or', f.or] as const)
  const compiled = children.map((child, i) =>
    compileFilter(byId, child, `${path}.${kind}.${String(i)}`, errors),
  )
  if (compiled.some((c) => c === null)) return null
  return kind === 'and'
    ? { and: compiled as CompiledFilter[] }
    : { or: compiled as CompiledFilter[] }
}

/** Select and multi-select by option order (a list by its earliest option), text by case. */
function sortKeyOf(attribute: Attribute): CompiledSort['key'] {
  switch (attribute.type) {
    case 'select':
    case 'multi_select':
      return { by: 'position', order: attribute.config.options.map((o) => o.id) }
    case 'text':
    case 'url':
      return { by: 'lower' }
    default:
      return { by: 'value' }
  }
}

/**
 * Checks `where` and `sort` against the attributes of the queried folder and resolves them to
 * `item_index` columns. Returns every problem found, each naming the attribute and operator.
 */
export function compileItemQuery(
  attributes: readonly Attribute[],
  query: { where: Filter | null; sort: z.output<typeof sortSchema> },
): CompileItemQueryResult {
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const errors: QueryError[] = []
  const where = query.where && compileFilter(byId, query.where, 'where', errors)

  const sort: CompiledSort[] = []
  for (const [i, key] of query.sort.entries()) {
    const resolved = resolve(byId, key.attribute, `sort.${String(i)}`, errors)
    if (!resolved) continue
    const { attribute, column } = resolved
    if (!attributeTypes[attribute.type].sortable) {
      errors.push({
        path: `sort.${String(i)}`,
        message: `Attribute "${attribute.id}" is a ${attribute.type} attribute, which cannot be sorted`,
      })
      continue
    }
    sort.push({
      attributeId: attribute.id,
      column,
      direction: key.direction,
      key: sortKeyOf(attribute),
    })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, where, sort }
}

/** One `item_index` row's typed value. `ord` numbers the rows of a multi-valued attribute. */
export interface IndexEntry {
  ord: number
  column: IndexColumn
  value: number | string
}

function entriesWith<C, V extends ItemValue>(
  type: AttributeType<AttributeTypeName, C, V>,
  config: C,
  value: ItemValue,
): IndexEntry[] {
  const column = type.indexProjection
  if (column === 'none') return []
  return type
    .project(value as V, config)
    .map((projected, ord) => ({ ord, column, value: projected }))
}

/**
 * The `item_index` rows for one stored, validated value of an indexed attribute. Empty for an
 * unindexed attribute, a cleared value, or a type that does not project. The write path
 * replaces all of an item's rows for the attribute with these.
 */
export function indexEntries(attribute: Attribute, value: ItemValue | null): IndexEntry[] {
  if (!attribute.indexed || value === null) return []
  switch (attribute.type) {
    case 'text':
      return entriesWith(attributeTypes.text, attribute.config, value)
    case 'number':
      return entriesWith(attributeTypes.number, attribute.config, value)
    case 'boolean':
      return entriesWith(attributeTypes.boolean, attribute.config, value)
    case 'date':
      return entriesWith(attributeTypes.date, attribute.config, value)
    case 'select':
      return entriesWith(attributeTypes.select, attribute.config, value)
    case 'multi_select':
      return entriesWith(attributeTypes.multi_select, attribute.config, value)
    case 'url':
      return entriesWith(attributeTypes.url, attribute.config, value)
    case 'actor':
      return entriesWith(attributeTypes.actor, attribute.config, value)
    case 'auto_id':
      return entriesWith(attributeTypes.auto_id, attribute.config, value)
    case 'rich_text':
      return entriesWith(attributeTypes.rich_text, attribute.config, value)
    case 'relation':
      return entriesWith(attributeTypes.relation, attribute.config, value)
  }
}
