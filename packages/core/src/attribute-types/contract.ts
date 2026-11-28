import type { z } from 'zod'
import type { RichTextDoc } from './rich-text-doc.ts'

/**
 * The attribute types implemented so far. D12 lists the full closed set of 13; file and
 * rollup land later (D44).
 */
export const ATTRIBUTE_TYPE_NAMES = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi_select',
  'url',
  'actor',
  'auto_id',
  'rich_text',
  'relation',
] as const
export type AttributeTypeName = (typeof ATTRIBUTE_TYPE_NAMES)[number]

/**
 * A stored, non-empty value. `null` means "no value" and is handled outside the type.
 * Lists hold option, principal, or item IDs (multi-select, actor, relation); rich text is a
 * JSON document.
 */
export type ItemValue = string | number | boolean | string[] | RichTextDoc

/** Which typed column of `item_index` a value is copied into, if any. */
export type IndexProjection = 'num' | 'txt' | 'ts' | 'none'

/** Every filter operator. Each type lists the ones it supports in `filterOperators`. */
export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
  /**
   * Date attributes with a `freshFor` only (D69): no value; true when the value is empty or
   * older than the server clock minus `freshFor`.
   */
  'is_stale',
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export type SummaryFunction =
  | 'count'
  | 'count_empty'
  | 'count_not_empty'
  | 'count_unique'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'earliest'
  | 'latest'
  | 'count_true'
  | 'count_false'

export type JsonSchema = Record<string, unknown>

/**
 * The contract every attribute type implements (docs/ARCHITECTURE.md, "Type contract").
 * `C` is the attribute's config, `V` the stored value. Methods that take a value are only
 * called with non-empty values; empty (`null`) sorts and groups separately in the query layer.
 */
export interface AttributeType<N extends AttributeTypeName, C, V extends ItemValue> {
  readonly name: N

  // 1. JSON shape and validation
  readonly configSchema: z.ZodType<C>
  valueSchema(config: C): z.ZodType<V>
  /**
   * True if only the server writes this value (auto ID). Clients get `read_only` for any
   * value they send, and the type is never `required` on create.
   */
  readonly readOnly: boolean
  /** True if a valid value should be stored as `null`, for example an empty string. */
  isEmpty(value: V, config: C): boolean

  // 2. Index projection
  readonly indexProjection: IndexProjection
  /**
   * The values written to the `item_index` column named by `indexProjection`, one row each
   * (numbered by `ord`). Empty for no row. Single-valued types return at most one value;
   * multi-valued types such as multi-select return one per selected value.
   */
  project(value: V, config: C): (number | string)[]

  // 3. Filter operators
  readonly filterOperators: readonly FilterOperator[]

  // 4. Sort key and group buckets
  /**
   * False if ordering by this type has no meaning without data the type cannot see, such as
   * a principal's or linked item's name (actor, relation), or would order whole documents
   * (rich text). The query layer refuses to sort on it. `sortKey` is still deterministic.
   */
  readonly sortable: boolean
  sortKey(value: V, config: C): number | string
  /**
   * The bucket a value groups into. A multi-valued type returns its whole combination in a
   * canonical order; per-value buckets are decided with grouping in views (M4).
   */
  groupKey(value: V, config: C): string

  // 5. Summary functions (computed from M4, with aggregate; new types list the base set)
  readonly summaries: readonly SummaryFunction[]

  // 6. Agent form
  jsonSchema(config: C): JsonSchema
  render(value: V | null, config: C): string
}

export const EMPTY_OPERATORS = ['is_empty', 'is_not_empty'] as const satisfies FilterOperator[]
export const BASE_SUMMARIES = [
  'count',
  'count_empty',
  'count_not_empty',
] as const satisfies SummaryFunction[]
