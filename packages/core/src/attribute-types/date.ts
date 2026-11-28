import { z } from 'zod'
import { serverClockOffsetMs } from '../server-clock.ts'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

export const FRESH_FOR_MIN_MS = 60_000
export const FRESH_FOR_MAX_DAYS = 366

/**
 * Milliseconds in a `freshFor` duration, or `null` if it isn't one: an ISO 8601 duration in
 * weeks, days, hours, minutes and seconds, as `$now` takes (server-clock.ts), positive, from 1
 * minute to 366 days. `PT2H`, `P7D`, `P1W`. Years and months are refused, since their length
 * depends on the calendar.
 */
export function freshForMs(duration: string): number | null {
  if (duration.startsWith('-')) return null
  const ms = serverClockOffsetMs(duration)
  return ms === null || ms < FRESH_FOR_MIN_MS ? null : ms
}

/** A date attribute's "fresh for" duration (D69, #205). */
export const freshForSchema = z
  .string()
  .max(64)
  .refine((d) => freshForMs(d) !== null, {
    message: `An ISO 8601 duration in weeks, days, hours, minutes and seconds, from 1 minute to ${String(FRESH_FOR_MAX_DAYS)} days, for example "PT2H" or "P7D"`,
  })

/**
 * Without time, a value is a calendar date `YYYY-MM-DD`.
 * With time, a value is an ISO 8601 date-time with `Z` or an explicit offset.
 *
 * `freshFor` (D69): how long a value stays fresh. Only an attribute with one takes the
 * `is_stale` filter, which holds when the value is empty or older than the server clock minus
 * `freshFor`; a calendar date counts from its UTC midnight, as it is indexed. Absent: no
 * freshness. It can be set, changed or cleared with `PATCH /attributes/:attributeId`; values are
 * never rewritten.
 */
export const dateConfigSchema = z.strictObject({
  includeTime: z.boolean().default(false),
  freshFor: freshForSchema.optional(),
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
  readOnly: false,
  isEmpty: () => false,
  indexProjection: 'ts',
  project: (value) => [new Date(toEpoch(value)).toISOString()],
  // `is_stale` only with `freshFor`: `filterOperatorsOf` and `compileItemQuery` check that.
  filterOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...EMPTY_OPERATORS, 'is_stale'],
  sortable: true,
  sortKey: toEpoch,
  // Buckets by UTC calendar day. Per-viewer time zones come with views.
  groupKey: (value) => new Date(toEpoch(value)).toISOString().slice(0, 10),
  summaries: [...BASE_SUMMARIES, 'earliest', 'latest'],
  jsonSchema: (config) => ({ type: 'string', format: config.includeTime ? 'date-time' : 'date' }),
  render: (value) => value ?? '',
}
