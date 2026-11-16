import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

export const booleanConfigSchema = z.strictObject({})
export type BooleanConfig = z.infer<typeof booleanConfigSchema>

export const booleanType: AttributeType<'boolean', BooleanConfig, boolean> = {
  name: 'boolean',
  configSchema: booleanConfigSchema,
  valueSchema: () => z.boolean(),
  isEmpty: () => false,
  // Booleans are cheap to filter straight from `item.values`; they get no index column.
  indexProjection: 'none',
  project: () => null,
  filterOperators: ['eq', 'neq', ...EMPTY_OPERATORS],
  sortKey: (value) => (value ? 1 : 0),
  groupKey: (value) => String(value),
  summaries: [...BASE_SUMMARIES, 'count_true', 'count_false'],
  jsonSchema: () => ({ type: 'boolean' }),
  render: (value) => (value === null ? '' : value ? 'yes' : 'no'),
}
