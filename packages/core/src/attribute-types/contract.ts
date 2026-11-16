import type { z } from 'zod'

/** The attribute types implemented so far. D12 lists the full closed set of 13; the rest land later. */
export const ATTRIBUTE_TYPE_NAMES = ['text', 'number', 'boolean', 'date', 'select'] as const
export type AttributeTypeName = (typeof ATTRIBUTE_TYPE_NAMES)[number]

/** A stored, non-empty value. `null` means "no value" and is handled outside the type. */
export type ItemValue = string | number | boolean

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
  sortKey(value: V, config: C): number | string
  groupKey(value: V, config: C): string

  // 5. Summary functions
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
