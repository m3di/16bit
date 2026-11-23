import {
  checkFilterOperands,
  filterConditions,
  isServerClockValue,
  resolveFilterOperands,
  serverClockOffsetMs,
  type Attribute,
  type Filter,
  type QueryError,
} from '@16bit/core'
import { sql, type Transaction } from 'kysely'
import type { Database } from './db/database.ts'
import { HttpError } from './http.ts'

// `$me` and `$now` in reads (D79, D81): `POST /query` and `POST /aggregate` resolve them before
// the filter is compiled, so the query compiler and the SQL never see them. `$me` is the
// caller's principal. `$now` is the read's database clock (`now()`: the snapshot's own instant,
// the same for every operand of the request) plus the offset: an instant for a date attribute
// with time, else the calendar date in the request's time zone (`tz`, UTC when absent). `$block`
// is for views only (M4-05); here it is refused with the other misplaced operands, a 400.

type Trx = Transaction<Database>

/** A `$block` named a block that resolved to nothing (D77): its dependents are `unresolved`. */
export class Unresolved extends Error {
  readonly blocks: string[]

  constructor(blocks: string[]) {
    super(`Unresolved blocks: ${blocks.join(', ')}`)
    this.blocks = blocks
  }
}

/** Zone names Postgres knows (`pg_timezone_names`), read once per process. */
let zones: Promise<ReadonlySet<string>> | null = null

/**
 * 422 `invalid_time_zone` unless `tz` is a name in `pg_timezone_names` (D81). The list is read
 * once per process: it changes only with the server's time zone data.
 */
export async function checkTimeZone(trx: Trx, tz: string): Promise<void> {
  zones ??= sql<{ name: string }>`SELECT name FROM pg_timezone_names`
    .execute(trx)
    .then(({ rows }) => new Set(rows.map((r) => r.name)))
  let known: ReadonlySet<string>
  try {
    known = await zones
  } catch (error) {
    zones = null
    throw error
  }
  if (!known.has(tz)) {
    throw new HttpError('invalid_time_zone', `Unknown time zone ${JSON.stringify(tz)}`)
  }
}

const isObject = (v: unknown) => typeof v === 'object' && v !== null

/** True if any condition's operand is an object (`$me`, `$now`, `$block`, or a malformed one). */
export function hasObjectOperands(filter: Filter | null | undefined): boolean {
  if (!filter) return false
  return filterConditions(filter, '').some(
    ({ condition: { value } }) =>
      (isObject(value) && !Array.isArray(value)) ||
      (Array.isArray(value) && (value as unknown[]).some(isObject)),
  )
}

/**
 * Each filter with `$me` and `$now` resolved, in order. `filters` are checked first: a misplaced
 * or malformed operand, or any `$block`, is a 400 `invalid_request` listing every problem, as a
 * query's other problems are. `tz` must have passed `checkTimeZone`.
 *
 * In a view (view-data.ts), `blocks` holds the item each item-bound block resolved to, and
 * `$block` is allowed and resolved from it; one that resolved to nothing throws `Unresolved`.
 */
export async function resolveReadFilters(
  trx: Trx,
  attributes: readonly Attribute[],
  me: string,
  tz: string,
  filters: readonly { where: Filter | null | undefined; path: string }[],
  blocks?: ReadonlyMap<string, string | null>,
): Promise<(Filter | null)[]> {
  const errors: QueryError[] = filters.flatMap(({ where, path }) =>
    where ? checkFilterOperands(attributes, where, path, { blocks: blocks !== undefined }) : [],
  )
  if (errors.length > 0) {
    throw new HttpError(
      'invalid_request',
      errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      { errors },
    )
  }
  const offsets = new Set<number>()
  for (const { where } of filters) {
    if (!where) continue
    for (const { condition } of filterConditions(where, '')) {
      if (isServerClockValue(condition.value)) {
        const ms = serverClockOffsetMs(String(condition.value.$now))
        if (ms !== null) offsets.add(ms)
      }
    }
  }
  const clock = new Map<number, { day: string; at: string }>()
  if (offsets.size > 0) {
    const { rows } = await sql<{ ms: number; day: string; at: Date }>`
      SELECT o.ms,
             to_char((now() + o.ms * interval '1 millisecond') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
             now() + o.ms * interval '1 millisecond' AS at
      FROM unnest(${[...offsets]}::double precision[]) AS o(ms)
    `.execute(trx)
    for (const row of rows) clock.set(row.ms, { day: row.day, at: row.at.toISOString() })
  }
  return filters.map(({ where }) => {
    if (!where) return null
    const resolved = resolveFilterOperands(attributes, where, {
      me,
      now: (value, includeTime) => {
        const at = clock.get(serverClockOffsetMs(value.$now) ?? Number.NaN)
        if (!at) throw new Error(`No clock read for ${value.$now}`)
        return includeTime ? at.at : at.day
      },
      ...(blocks && { blocks }),
    })
    // Outside a view `$block` is refused above, so only a view gets here.
    if (!resolved.ok) throw new Unresolved(resolved.unresolved)
    return resolved.filter
  })
}
