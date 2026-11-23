import {
  compileItemQuery,
  isServerClockValue,
  resolveServerClock,
  serverClockValueSchema,
  type Attribute,
  type CompiledFilter,
  type Filter,
  type FilterCondition,
  type FilterOperator,
  type FolderAttributeDefinition,
  type Item,
  type ValueError,
} from '@16bit/core'
import { sql, type Transaction } from 'kysely'
import type { Database } from './db/database.ts'
import { HttpError } from './http.ts'

// Write preconditions and server-clock values (D66, #203). A condition is the query's `where`
// tree, compiled by core's `compileItemQuery` as for `POST /query`, but over every attribute of
// the item's folder (one item is read, so nothing needs the index), and evaluated by the same SQL
// against the item's current values (`conditionHolds` in items.ts). `{ "$now": "<duration>" }`
// is resolved here, before values are validated and conditions compiled, with the write's one
// clock reading: so the stored value and the compared operand are ordinary dates.

/**
 * The write's clock (D66): `clock_timestamp()`, read when called, not the transaction's start.
 * A patch reads it after its row lock, so a wait for the lock doesn't age it.
 */
export async function writeClock(trx: Transaction<Database>): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
  const now = rows[0]?.now
  if (!now) throw new Error('no clock_timestamp()')
  return now
}

/** Whether `values` has any `$now` value, so the write needs the clock. */
export const hasClockValue = (values: Record<string, unknown>): boolean =>
  Object.values(values).some(isServerClockValue)

/** Whether a condition tree has any `$now` operand. */
export function hasClockOperand(filter: Filter): boolean {
  if ('and' in filter) return filter.and.some(hasClockOperand)
  if ('or' in filter) return filter.or.some(hasClockOperand)
  return (
    isServerClockValue(filter.value) ||
    (Array.isArray(filter.value) && filter.value.some(isServerClockValue))
  )
}

const CLOCK_OPERATORS: readonly FilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']

/** One `$now` resolved for `attribute`, or a message saying why it can't be. */
function resolveOne(
  attribute: Attribute | undefined,
  value: unknown,
  now: Date,
): { ok: true; value: string } | { ok: false; message: string } {
  if (attribute?.type !== 'date') {
    return { ok: false, message: '$now is only for date attributes' }
  }
  const parsed = serverClockValueSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid $now' }
  }
  return {
    ok: true,
    value: resolveServerClock(parsed.data, now, attribute.config.includeTime),
  }
}

/**
 * `values` with each `$now` on a date attribute of the folder replaced by its date at `now`. A
 * `$now` on another attribute, or a malformed one, is 422 `invalid_values` like any invalid
 * value. An attribute the folder doesn't show is left for validation to refuse.
 */
export function resolveClockValues(
  definitions: FolderAttributeDefinition[],
  values: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  if (!hasClockValue(values)) return values
  const byId = new Map(definitions.map((d) => [d.attribute.id, d.attribute]))
  const errors: ValueError[] = []
  const resolved: Record<string, unknown> = { ...values }
  for (const [attributeId, value] of Object.entries(values)) {
    if (!isServerClockValue(value) || !byId.has(attributeId)) continue
    const result = resolveOne(byId.get(attributeId), value, now)
    if (result.ok) resolved[attributeId] = result.value
    else errors.push({ attributeId, code: 'invalid_value', message: result.message })
  }
  if (errors.length > 0) {
    throw new HttpError('invalid_values', 'Some values are not valid', { errors })
  }
  return resolved
}

/**
 * Compiles a condition against the folder's attributes, with each `$now` operand resolved at
 * `now`. Every attribute may be named, indexed or not; each type keeps its own operators and
 * operand checks. `$now` is an operand of `eq`, `neq`, `gt`, `gte`, `lt` and `lte` on a date
 * attribute only. Every problem is a 400 `invalid_request` listing them all, as for a query,
 * with paths under `condition`.
 */
export function compileCondition(
  definitions: FolderAttributeDefinition[],
  condition: Filter,
  now: Date,
): CompiledFilter {
  // Every type projects to an index column, so marking all attributes indexed lets the
  // query compiler check any of them.
  const attributes = definitions.map((d): Attribute => ({ ...d.attribute, indexed: true }))
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const errors: { path: string; message: string }[] = []

  // A condition whose `$now` was already reported, kept in the tree as a check the compiler
  // accepts for any attribute, so it reports nothing more about it.
  const reported = (filter: FilterCondition): Filter => ({
    attribute: filter.attribute,
    op: 'is_empty',
  })
  const resolve = (filter: Filter, path: string): Filter => {
    if ('and' in filter)
      return { and: filter.and.map((f, i) => resolve(f, `${path}.and.${String(i)}`)) }
    if ('or' in filter)
      return { or: filter.or.map((f, i) => resolve(f, `${path}.or.${String(i)}`)) }
    const clocked =
      isServerClockValue(filter.value) ||
      (Array.isArray(filter.value) && filter.value.some(isServerClockValue))
    if (!clocked) return filter
    const attribute = byId.get(filter.attribute)
    if (!CLOCK_OPERATORS.includes(filter.op) || Array.isArray(filter.value)) {
      errors.push({
        path: `${path}.value`,
        message: `${filter.op} on "${filter.attribute}": $now is an operand of eq, neq, gt, gte, lt and lte only`,
      })
      return reported(filter)
    }
    // An unknown attribute is reported by the compiler.
    if (!attribute) return filter
    const result = resolveOne(attribute, filter.value, now)
    if (!result.ok) {
      errors.push({
        path: `${path}.value`,
        message: `${filter.op} on "${filter.attribute}": ${result.message}`,
      })
      return reported(filter)
    }
    return { ...filter, value: result.value }
  }

  const resolved = resolve(condition, 'condition')
  // Compiled even after a `$now` problem, so every other problem is listed with it.
  const compiled = compileItemQuery(attributes, { where: resolved, sort: [] })
  if (!compiled.ok) {
    errors.push(
      ...compiled.errors.map((e) => ({ ...e, path: e.path.replace(/^where/, 'condition') })),
    )
  }
  if (errors.length === 0 && compiled.ok && compiled.where) return compiled.where
  throw new HttpError('invalid_request', errors.map((e) => `${e.path}: ${e.message}`).join('; '), {
    errors,
  })
}

/** 412 `precondition_failed`: nothing was written. `current` is null when no item exists. */
export const preconditionFailed = (current: Item | null) =>
  new HttpError('precondition_failed', 'The condition does not hold on the item as it is', {
    current,
  })
