import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

/**
 * Without time, a value is a calendar date `YYYY-MM-DD`.
 * With time, a value is an ISO 8601 date-time with `Z` or an explicit offset.
 */
export const dateConfigSchema = z.strictObject({
  includeTime: z.boolean().default(false),
})
export type DateConfig = z.infer<typeof dateConfigSchema>

/** UTC epoch milliseconds. A calendar date maps to UTC midnight. */
function toEpoch(value: string): number {
  return Date.parse(value)
}

export const dateType: AttributeType<'date', DateConfig, string> = {
  name: 'date',
  configSchema: dateConfigSchema,
  valueSchema: (config) => (config.includeTime ? z.iso.datetime({ offset: true }) : z.iso.date()),
  isEmpty: () => false,
  indexProjection: 'ts',
  project: (value) => new Date(toEpoch(value)).toISOString(),
  filterOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...EMPTY_OPERATORS],
  sortKey: toEpoch,
  // Buckets by UTC calendar day. Per-viewer time zones come with views.
  groupKey: (value) => new Date(toEpoch(value)).toISOString().slice(0, 10),
  summaries: [...BASE_SUMMARIES, 'earliest', 'latest'],
  jsonSchema: (config) => ({ type: 'string', format: config.includeTime ? 'date-time' : 'date' }),
  render: (value) => value ?? '',
}
