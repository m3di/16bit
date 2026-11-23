import { z } from 'zod'
import { aggregateGroupSchema, timeZoneSchema } from './aggregate.ts'
import { linkedItemSchema } from './api.ts'
import { idSchema, itemSchema } from './entities.ts'
import { MAX_VIEW_BLOCKS, viewErrorSchema } from './views.ts'

// View data (D83): `GET /v1/workspaces/:workspaceId/folders/:folderId/view/data`, every data
// block of the folder's view (stored, or the default at version 0) in one read-only snapshot
// with one `seq`, read as the caller under row-level security (D79).

/** Items one view-data response carries across all its blocks. */
export const MAX_VIEW_DATA_ITEMS = 1_000
/** One deadline for the whole request; blocks not run by then answer `error: timeout`. */
export const VIEW_DATA_DEADLINE_MS = 5_000
/**
 * View-data and aggregate requests one principal may have in flight per API process; the next
 * answers 429 `rate_limited`. The client queues it and retries once its own requests finish.
 */
export const MAX_VIEW_REQUESTS_IN_FLIGHT = 4

/**
 * Query string. `version` is the tree version the client holds (`0` for the default); a stored
 * tree that moved past it answers 409 `stale` and the client reloads the view. `blocks` limits
 * the answer to some blocks (comma-separated IDs), for a refetch. `tz` as in D81: UTC when
 * absent, 422 `invalid_time_zone` when unknown. A hidden or missing folder is 404.
 */
export const viewDataQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(0),
  blocks: z
    .string()
    .max(MAX_VIEW_BLOCKS * 65)
    .transform((s) => s.split(','))
    .pipe(z.array(idSchema).min(1).max(MAX_VIEW_BLOCKS))
    .optional(),
  tz: timeZoneSchema.optional(),
})
export type ViewDataQuery = z.input<typeof viewDataQuerySchema>

const linked = { linked: z.record(idSchema, linkedItemSchema).optional() }

/**
 * `table` and `list`: the first `limit` items in the binding's order, `total` items that pass
 * its `where`, and for a grouped list one entry per group with its measures (`groups`, keyed as
 * in `POST /aggregate`). `linked` holds the items that relation fields shown point to.
 */
export const itemsBlockDataSchema = z.strictObject({
  kind: z.literal('items'),
  items: z.array(itemSchema),
  total: z.int().min(0),
  groups: z.array(aggregateGroupSchema).optional(),
  ...linked,
})

/** `board`: one entry per configured column, in order, empty ones included. */
export const boardBlockDataSchema = z.strictObject({
  kind: z.literal('board'),
  columns: z.array(
    z.strictObject({ option: idSchema, items: z.array(itemSchema), total: z.int().min(0) }),
  ),
  ...linked,
})

/**
 * `number` (`aggregate`: one group, `kind: "all"`, with `[value, total?]`) and `chart`
 * (`bars`): as `POST /aggregate` answers.
 */
export const aggregateBlockDataSchema = z.strictObject({
  kind: z.literal('aggregate'),
  groups: z.array(aggregateGroupSchema),
  truncated: z.boolean(),
})

/**
 * `number` (`days`): today's day between the item's `start` and `end` dates, counted as the
 * block's `days` says (D81), `of` days in all. `day` is `null` outside the range, and both
 * are `null` when a date is empty.
 */
export const daysBlockDataSchema = z.strictObject({
  kind: z.literal('days'),
  day: z.int().min(1).nullable(),
  of: z.int().min(0).nullable(),
})

const calendarDate = z.iso.date()

/**
 * `chart` (`burndown`, D82): `total` points (or items) of the set, and per day from `start` to
 * `end` (stepping over the block's `days`) what remains: `total` minus what was done on or
 * before that day by `doneOn`. Days after `today` are `null`. The ideal line runs from `total`
 * on `start` to 0 on `end`; the client draws it.
 */
export const burndownBlockDataSchema = z.strictObject({
  kind: z.literal('burndown'),
  start: calendarDate,
  end: calendarDate,
  today: calendarDate,
  total: z.number(),
  days: z.array(z.strictObject({ date: calendarDate, remaining: z.number().nullable() })),
})

/** `fields`, and the item a `number` (`days`) block reads: `null` when the binding found none. */
export const itemBlockDataSchema = z.strictObject({
  kind: z.literal('item'),
  item: itemSchema.nullable(),
  ...linked,
})

export const blockDataSchema = z.discriminatedUnion('kind', [
  itemsBlockDataSchema,
  boardBlockDataSchema,
  aggregateBlockDataSchema,
  daysBlockDataSchema,
  burndownBlockDataSchema,
  itemBlockDataSchema,
])
export type BlockData = z.infer<typeof blockDataSchema>

export const BLOCK_STATUSES = ['ok', 'invalid', 'not_found', 'unresolved', 'error'] as const

/**
 * Each data block's answer (D18's states besides loading come from these):
 *
 * - `ok`: `data` by the block's kind.
 * - `invalid`: the block names a removed or non-indexed attribute or a missing folder
 *   (`checkViewTree`), with its errors. The rest of the page renders.
 * - `not_found`: a fixed item binding's item is gone or hidden.
 * - `unresolved`: a `$block` (or a burndown's range) names a block that resolved to nothing,
 *   listed in `blocks` (no current sprint, or it is hidden). A designed empty state.
 * - `error`: `timeout` past the request deadline, `item_cap` once the response holds
 *   `MAX_VIEW_DATA_ITEMS` items, or `internal`.
 */
export const blockStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), data: blockDataSchema }),
  z.strictObject({ status: z.literal('invalid'), errors: z.array(viewErrorSchema) }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({ status: z.literal('unresolved'), blocks: z.array(idSchema) }),
  z.strictObject({
    status: z.literal('error'),
    error: z.enum(['timeout', 'item_cap', 'internal']),
  }),
])
export type BlockStatus = z.infer<typeof blockStatusSchema>

/**
 * The answer: one entry per data block of the tree (or of `blocks`), keyed by block ID, all
 * read in one snapshot as of `seq`, which the client subscribes from (D58). Item bindings are
 * resolved first, then the blocks that name them with `$block`.
 */
export const viewDataSchema = z.strictObject({
  folderId: idSchema,
  version: z.int().min(0),
  blocks: z.record(idSchema, blockStatusSchema),
  seq: z.int().min(0),
})
export type ViewData = z.infer<typeof viewDataSchema>
