import { z } from 'zod'
import type { Attribute } from './entities.ts'
import { idSchema } from './ids.ts'
import type { Filter, FilterCondition, QueryError } from './query.ts'
import {
  isServerClockValue,
  serverClockValueSchema,
  type ServerClockValue,
} from './server-clock.ts'

// Operands the server fills in at read time (D79): `$me`, `$now` and `$block`. A filter that
// uses them is checked with `checkFilterOperands`, then resolved with `resolveFilterOperands`
// into a plain filter, which `compileItemQuery` checks and compiles as before. So the query
// compiler never sees them, and a resolved operand is checked like one the caller typed.
//
// - `{ "$me": true }`: the caller's principal ID. An element of the value of `in` or `not_in`
//   on an actor attribute. Allowed in `POST /query`, `POST /aggregate` and views.
// - `{ "$now": "<duration>" }`: the read's clock plus an ISO 8601 duration (server-clock.ts,
//   #199). The operand of `eq`, `neq`, `gt`, `gte`, `lt` or `lte` on a date attribute. For a
//   date without time it is the calendar date in the request's time zone (`tz`, D81), else the
//   instant. Allowed in `POST /query`, `POST /aggregate` and views.
// - `{ "$block": "<block id>" }`: the item an item-bound block of the same view resolved to.
//   An element of the value of `in` or `not_in` on a relation attribute. Views only, never in
//   an item binding's rule (D77). When the block resolved to nothing, the blocks that use it
//   get the status `unresolved`.

export const meOperandSchema = z.strictObject({ $me: z.literal(true) })
export type MeOperand = z.infer<typeof meOperandSchema>

export const blockOperandSchema = z.strictObject({ $block: idSchema })
export type BlockOperand = z.infer<typeof blockOperandSchema>

export type ServerOperand = MeOperand | ServerClockValue | BlockOperand

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isMe = (v: unknown): v is { $me: unknown } => isObject(v) && '$me' in v
const isBlock = (v: unknown): v is { $block: unknown } => isObject(v) && '$block' in v

/** Where a filter is used, which decides the operands it may carry. */
export interface OperandContext {
  /** `$block` is allowed: a view's set binding, measure or group `where`. */
  blocks: boolean
}

const isCondition = (f: Filter): f is FilterCondition => 'op' in f

/** Every condition of a filter tree with its path, in order. */
export function filterConditions(
  filter: Filter,
  path: string,
): { condition: FilterCondition; path: string }[] {
  if (isCondition(filter)) return [{ condition: filter, path }]
  const [kind, children] =
    'and' in filter ? (['and', filter.and] as const) : (['or', filter.or] as const)
  return children.flatMap((child, i) => filterConditions(child, `${path}.${kind}.${String(i)}`))
}

/** The number of conditions in a filter tree. */
export const countConditions = (filter: Filter | null | undefined): number =>
  filter ? filterConditions(filter, '').length : 0

/** Every block ID named by `$block` in a filter. */
export function blockReferences(filter: Filter | null | undefined): string[] {
  if (!filter) return []
  const ids: string[] = []
  for (const { condition } of filterConditions(filter, '')) {
    if (!Array.isArray(condition.value)) continue
    for (const v of condition.value as unknown[]) {
      if (isBlock(v) && typeof v.$block === 'string') ids.push(v.$block)
    }
  }
  return ids
}

/** True if the filter uses `$now` anywhere (its block refetches at midnight, D83). */
export function usesNow(filter: Filter | null | undefined): boolean {
  if (!filter) return false
  return filterConditions(filter, '').some(({ condition }) => isServerClockValue(condition.value))
}

const LIST_OPS = new Set(['in', 'not_in'])
const DATE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'])

/**
 * Checks that every `$me`, `$now` and `$block` in `filter` is well formed and sits where it is
 * allowed (see the top of this file). `attributes` are the queried folder's; a condition on an
 * attribute not among them is left to `compileItemQuery` to report. Returns every problem.
 */
export function checkFilterOperands(
  attributes: readonly Attribute[],
  filter: Filter,
  path: string,
  context: OperandContext,
): QueryError[] {
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const errors: QueryError[] = []
  for (const { condition, path: at } of filterConditions(filter, path)) {
    const type = byId.get(condition.attribute)?.type
    const where = `${at}.value`
    const { value, op } = condition
    if (isServerClockValue(value)) {
      if (!serverClockValueSchema.safeParse(value).success) {
        errors.push({ path: where, message: '$now needs an ISO 8601 duration, for example "-P1D"' })
      } else if (type !== undefined && (type !== 'date' || !DATE_OPS.has(op))) {
        errors.push({
          path: where,
          message: '$now is the operand of eq, neq, gt, gte, lt or lte on a date attribute',
        })
      }
      continue
    }
    if (isMe(value) || isBlock(value)) {
      errors.push({
        path: where,
        message: 'Use $me and $block as elements of an in or not_in list',
      })
      continue
    }
    if (!Array.isArray(value)) continue
    for (const [i, element] of (value as unknown[]).entries()) {
      const p = `${where}.${String(i)}`
      if (isServerClockValue(element)) {
        errors.push({ path: p, message: '$now is a single operand, not a list element' })
      } else if (isMe(element)) {
        if (!meOperandSchema.safeParse(element).success) {
          errors.push({ path: p, message: '$me is written { "$me": true }' })
        } else if (type !== undefined && (type !== 'actor' || !LIST_OPS.has(op))) {
          errors.push({
            path: p,
            message: '$me is an element of in or not_in on an actor attribute',
          })
        }
      } else if (isBlock(element)) {
        if (!context.blocks) {
          errors.push({
            path: p,
            message: '$block is allowed only in a view, outside item binding rules',
          })
        } else if (!blockOperandSchema.safeParse(element).success) {
          errors.push({ path: p, message: '$block names a block ID' })
        } else if (type !== undefined && (type !== 'relation' || !LIST_OPS.has(op))) {
          errors.push({
            path: p,
            message: '$block is an element of in or not_in on a relation attribute',
          })
        }
      }
    }
  }
  return errors
}

/** What the server knows at read time to fill operands in. */
export interface OperandValues {
  /** The caller's principal ID. */
  me: string
  /**
   * The stored form of `$now` for a date attribute: the read's clock plus the offset, as a
   * calendar date in the request's time zone without time, or an ISO instant with it.
   */
  now: (value: ServerClockValue, includeTime: boolean) => string
  /** Item each item-bound block resolved to; `null` when it resolved to nothing. */
  blocks?: ReadonlyMap<string, string | null>
}

export type ResolveOperandsResult =
  | { ok: true; filter: Filter }
  /** A `$block` named a block that resolved to nothing (or none known): status `unresolved`. */
  | { ok: false; unresolved: string[] }

/**
 * `filter` with every `$me`, `$now` and `$block` replaced by its value. Run after
 * `checkFilterOperands`; the result goes to `compileItemQuery`. Operands it does not recognise
 * are left for the compiler to refuse.
 */
export function resolveFilterOperands(
  attributes: readonly Attribute[],
  filter: Filter,
  values: OperandValues,
): ResolveOperandsResult {
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const unresolved = new Set<string>()
  const element = (v: unknown): unknown => {
    if (isMe(v)) return values.me
    if (isBlock(v) && typeof v.$block === 'string') {
      const item = values.blocks?.get(v.$block)
      if (item === undefined || item === null) {
        unresolved.add(v.$block)
        return v
      }
      return item
    }
    return v
  }
  const walk = (f: Filter): Filter => {
    if ('and' in f) return { and: f.and.map(walk) }
    if ('or' in f) return { or: f.or.map(walk) }
    const attribute = byId.get(f.attribute)
    let value = f.value
    if (isServerClockValue(value) && serverClockValueSchema.safeParse(value).success) {
      const includeTime = attribute?.type === 'date' && attribute.config.includeTime
      value = values.now(value as ServerClockValue, includeTime)
    } else if (Array.isArray(value)) {
      value = (value as unknown[]).map(element)
    }
    return value === undefined ? { ...f } : { ...f, value }
  }
  const resolved = walk(filter)
  return unresolved.size > 0
    ? { ok: false, unresolved: [...unresolved] }
    : { ok: true, filter: resolved }
}

/**
 * `filter` with placeholder values for its operands, so `compileItemQuery` can check the rest
 * of it without knowing the caller or the clock. For validation only.
 */
export function withPlaceholderOperands(attributes: readonly Attribute[], filter: Filter): Filter {
  const blocks = new Map(blockReferences(filter).map((id) => [id, id]))
  const result = resolveFilterOperands(attributes, filter, {
    me: 'placeholder-principal',
    now: (_value, includeTime) => (includeTime ? '2000-01-01T00:00:00.000Z' : '2000-01-01'),
    blocks,
  })
  return result.ok ? result.filter : filter
}
