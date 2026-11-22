import { z } from 'zod'

// Server-clock date values (D66, #199): a date set or compared as "the database's now, plus an
// offset", so agents never need to trust their own clocks.

export const MAX_SERVER_CLOCK_OFFSET_DAYS = 366
const DAY_MS = 86_400_000
export const MAX_SERVER_CLOCK_OFFSET_MS = MAX_SERVER_CLOCK_OFFSET_DAYS * DAY_MS

// `-`? `P` [n`W`] [n`D`] [`T` [n`H`] [n`M`] [n[.fff]`S`]]. Years and months are refused: their
// length depends on the calendar, so an offset would not be an exact span.
const DURATION =
  /^(-)?P(?:(\d{1,9})W)?(?:(\d{1,9})D)?(?:T(?:(\d{1,9})H)?(?:(\d{1,9})M)?(?:(\d{1,9}(?:\.\d{1,3})?)S)?)?$/

/**
 * Milliseconds in an ISO 8601 duration of weeks, days, hours, minutes and seconds (seconds may
 * have up to three decimals), negative with a leading `-`: `PT45M`, `-P1D`, `P1W2DT3H`,
 * `PT0.5S`. Returns `null` for anything else: years or months, a bare `P` or `PT`, a sign other
 * than `-`, lowercase letters, or an offset over 366 days either way.
 */
export function serverClockOffsetMs(duration: string): number | null {
  const m = DURATION.exec(duration)
  if (!m) return null
  const [, sign, weeks, days, hours, minutes, seconds] = m
  const parts = [weeks, days, hours, minutes, seconds]
  if (parts.every((p) => p === undefined)) return null
  // `PT` with nothing after it.
  if (
    duration.includes('T') &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return null
  }
  const n = (p: string | undefined) => (p === undefined ? 0 : Number(p))
  const ms =
    n(weeks) * 7 * DAY_MS +
    n(days) * DAY_MS +
    n(hours) * 3_600_000 +
    n(minutes) * 60_000 +
    Math.round(n(seconds) * 1000)
  if (ms > MAX_SERVER_CLOCK_OFFSET_MS) return null
  // `-PT0S` is zero, not negative zero.
  return sign && ms !== 0 ? -ms : ms
}

/**
 * A date value or a date condition operand that the server fills in (D66): the database clock,
 * read once per write inside its transaction (after the item's row lock), plus the offset. Every
 * `$now` in one write, values and condition alike, sees the same instant. Accepted wherever a
 * date attribute takes a value: in `values` of create, patch, upsert and batch operations, and
 * as the operand of a `condition` on a date attribute (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`,
 * and each element of `in` and `not_in`). Not in `POST /query`, whose reads have no write
 * transaction. The stored value is an ordinary date: see `resolveServerClock`.
 */
export const serverClockValueSchema = z.strictObject({
  $now: z
    .string()
    .max(64)
    .refine((d) => serverClockOffsetMs(d) !== null, {
      message: `An ISO 8601 duration in weeks, days, hours, minutes and seconds, at most ${String(MAX_SERVER_CLOCK_OFFSET_DAYS)} days either way, for example "PT45M" or "-P1D"`,
    }),
})
export type ServerClockValue = z.infer<typeof serverClockValueSchema>

/** Whether a value is shaped like `{ "$now": ... }`, valid or not, so it is checked as one. */
export function isServerClockValue(value: unknown): value is { $now: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '$now' in value
}

/**
 * The stored date for a server-clock value, given the database clock: an ISO date-time in UTC
 * with milliseconds for a date attribute with time, or the UTC calendar date (`YYYY-MM-DD`)
 * without. The value must have passed `serverClockValueSchema`.
 */
export function resolveServerClock(
  value: ServerClockValue,
  now: Date,
  includeTime: boolean,
): string {
  const offset = serverClockOffsetMs(value.$now)
  if (offset === null) throw new Error(`Invalid server-clock offset: ${value.$now}`)
  const iso = new Date(now.getTime() + offset).toISOString()
  return includeTime ? iso : iso.slice(0, 10)
}
