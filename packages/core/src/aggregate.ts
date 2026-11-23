import { z } from 'zod'
import {
  attributeTypes,
  type AttributeTypeName,
  type SummaryFunction,
} from './attribute-types/index.ts'
import { idSchema, type Attribute } from './entities.ts'
import {
  checkFilterOperands,
  countConditions,
  withPlaceholderOperands,
  type OperandContext,
} from './operands.ts'
import { boundedFilterSchema, compileItemQuery, type Filter, type QueryError } from './query.ts'

// Aggregates (D80, D81): `POST /v1/workspaces/:workspaceId/aggregate`, and the `number`,
// `chart` and `list` group measures of views, which run the same engine. Read as the caller
// under row-level security, in one snapshot with the workspace `seq` (D79).

/** Every summary function an attribute type may list (`AttributeType.summaries`). */
export const SUMMARY_FUNCTIONS = [
  'count',
  'count_empty',
  'count_not_empty',
  'count_unique',
  'sum',
  'avg',
  'min',
  'max',
  'earliest',
  'latest',
  'count_true',
  'count_false',
] as const satisfies readonly SummaryFunction[]

export const MAX_AGGREGATE_MEASURES = 5
/** Conditions across `where` and every measure's `where` together (D80). */
export const MAX_AGGREGATE_CONDITIONS = 40
/** Groups past this fold into one `other` group, with `truncated` (D80). */
export const MAX_AGGREGATE_GROUPS = 100
/** Date buckets past this fold into `other`, with `truncated` (D80). */
export const MAX_DATE_BUCKETS = 366
/** Statement timeout of one aggregate, answered as 503 `timeout` (D80). */
export const AGGREGATE_TIMEOUT_MS = 3_000

/**
 * An IANA time zone name, for example `Europe/Berlin` (D81). The reader's browser zone; UTC
 * when absent. Its shape is checked here; a name Postgres does not know (`pg_timezone_names`)
 * is a 422 `invalid_time_zone`.
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/)

/** Types a group dimension may use (D80). */
export const GROUP_TYPES = [
  'select',
  'multi_select',
  'actor',
  'relation',
  'boolean',
  'date',
] as const satisfies readonly AttributeTypeName[]

/** Calendar buckets for a date group, in the request's time zone. Weeks start on Monday. */
export const DATE_BUCKETS = ['day', 'week', 'month'] as const

/**
 * One group dimension: an indexed attribute of a type in `GROUP_TYPES`, with `bucket` for a
 * date and only then. Multi-valued attributes (multi-select, actor with `multiple`, relation)
 * count an item in each of its groups, so group counts can sum past the total.
 */
export const groupBySchema = z.strictObject({
  attribute: idSchema,
  bucket: z.enum(DATE_BUCKETS).optional(),
})
export type GroupBy = z.infer<typeof groupBySchema>

/**
 * One measure: `fn` from the attribute type's `summaries`; `count` without `attribute`
 * counts items. `where` narrows the items this measure reads, so "done of total" is two
 * measures in one call. A measure's attribute must be indexed.
 */
export const measureSchema = z
  .strictObject({
    fn: z.enum(SUMMARY_FUNCTIONS),
    attribute: idSchema.optional(),
    where: boundedFilterSchema.optional(),
  })
  .refine((m) => m.fn === 'count' || m.attribute !== undefined, {
    path: ['attribute'],
    message: 'Every summary but count needs an attribute',
  })
export type Measure = z.infer<typeof measureSchema>

/** Conditions in a `where` and a list of measures, for the `MAX_AGGREGATE_CONDITIONS` cap. */
export const aggregateConditionCount = (
  where: Filter | null | undefined,
  measures: readonly { where?: Filter | undefined }[],
): number => countConditions(where) + measures.reduce((n, m) => n + countConditions(m.where), 0)

/**
 * `POST /v1/workspaces/:workspaceId/aggregate`. Items of one folder (`from`), narrowed by
 * `where` (the query's rules, D19, D20, plus `$me` and `$now`), grouped by at most one
 * dimension, with 1 to 5 measures. `tz` sets "today" for `$now` on dates without time and the
 * date buckets (D81). Checked against the folder's attributes by `checkAggregate`; problems
 * are a 400 `invalid_request` listing every one, as for a query.
 */
export const aggregateRequestSchema = z
  .strictObject({
    from: idSchema,
    where: boundedFilterSchema.nullable().default(null),
    groupBy: groupBySchema.optional(),
    measures: z.array(measureSchema).min(1).max(MAX_AGGREGATE_MEASURES),
    tz: timeZoneSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (aggregateConditionCount(request.where, request.measures) > MAX_AGGREGATE_CONDITIONS) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${String(MAX_AGGREGATE_CONDITIONS)} conditions across where and every measure's where`,
      })
    }
  })
export type AggregateRequest = z.input<typeof aggregateRequestSchema>
export type ParsedAggregateRequest = z.output<typeof aggregateRequestSchema>

/**
 * A group's key.
 *
 * - `all`: the one group when there is no `groupBy`.
 * - `value`: an option ID (select, multi-select), a principal ID (actor: IDs only, the client
 *   resolves names from the member list it can read, so an agent learns no names), an item ID
 *   with its title as `label` (relation, only for targets the caller can read), `true` or
 *   `false` (boolean), or a bucket's first day `YYYY-MM-DD` (date).
 * - `empty`: items with no value.
 * - `no_access`: every relation target the caller cannot read, in one group, so neither their
 *   IDs nor their number is revealed (D80, D11).
 * - `other`: the groups past `MAX_AGGREGATE_GROUPS` or `MAX_DATE_BUCKETS`, folded together.
 */
export const aggregateGroupKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('value'),
    value: z.union([z.string(), z.number(), z.boolean()]),
    label: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('empty') }),
  z.strictObject({ kind: z.literal('no_access') }),
  z.strictObject({ kind: z.literal('other') }),
])
export type AggregateGroupKey = z.infer<typeof aggregateGroupKeySchema>

/**
 * A measure's result: a number, a date (`earliest`, `latest`, as stored: `YYYY-MM-DD` or an
 * instant), or `null` when no item has a value (`sum`, `avg`, `min`, `max`, `earliest`,
 * `latest`). Counts are never null. `sum` and `avg` are rounded to the attribute's decimals.
 */
export const measureValueSchema = z.union([z.number(), z.string(), z.null()])
export type MeasureValue = z.infer<typeof measureValueSchema>

/** One group, with one value per measure in the order the measures were sent. */
export const aggregateGroupSchema = z.strictObject({
  key: aggregateGroupKeySchema,
  values: z.array(measureValueSchema),
})
export type AggregateGroup = z.infer<typeof aggregateGroupSchema>

/**
 * The answer of `POST /aggregate`. Group order: option order for select and multi-select,
 * then `empty`; ascending for date buckets, then `empty`; `false`, `true`, then `empty` for a
 * boolean; by the first measure, largest first, then by key, for actor and relation, with
 * `no_access` and `empty` after them. `other` is always last. `seq` as for a query (D58).
 */
export const aggregateResultSchema = z.strictObject({
  groups: z.array(aggregateGroupSchema),
  truncated: z.boolean(),
  seq: z.int().min(0),
})
export type AggregateResult = z.infer<typeof aggregateResultSchema>

const GROUPABLE: ReadonlySet<string> = new Set(GROUP_TYPES)

/** An attribute a group or measure may use: on the folder and indexed. */
function indexedAttribute(
  byId: ReadonlyMap<string, Attribute>,
  attributeId: string,
  path: string,
  errors: QueryError[],
): Attribute | null {
  const attribute = byId.get(attributeId)
  if (!attribute) {
    errors.push({ path, message: `Attribute "${attributeId}" is not an attribute of this folder` })
    return null
  }
  if (!attribute.indexed) {
    errors.push({
      path,
      message: `Attribute "${attributeId}" is not indexed; only indexed attributes can be grouped or summarised`,
    })
    return null
  }
  return attribute
}

/** Checks a group dimension against the folder's attributes. */
export function checkGroupBy(
  attributes: readonly Attribute[],
  groupBy: GroupBy,
  path: string,
): QueryError[] {
  const errors: QueryError[] = []
  const byId = new Map(attributes.map((a) => [a.id, a]))
  const attribute = indexedAttribute(byId, groupBy.attribute, `${path}.attribute`, errors)
  if (!attribute) return errors
  if (!GROUPABLE.has(attribute.type)) {
    errors.push({
      path: `${path}.attribute`,
      message: `Attribute "${attribute.id}" is a ${attribute.type} attribute; group by one of ${GROUP_TYPES.join(', ')}`,
    })
  } else if (attribute.type === 'date' && groupBy.bucket === undefined) {
    errors.push({
      path: `${path}.bucket`,
      message: 'A date group needs a bucket: day, week or month',
    })
  } else if (attribute.type !== 'date' && groupBy.bucket !== undefined) {
    errors.push({ path: `${path}.bucket`, message: 'Only a date group takes a bucket' })
  }
  return errors
}

/** Checks one filter: its operands, then the rest with `compileItemQuery`. */
export function checkFilter(
  attributes: readonly Attribute[],
  where: Filter,
  path: string,
  context: OperandContext,
): QueryError[] {
  const errors = checkFilterOperands(attributes, where, path, context)
  if (errors.length > 0) return errors
  const compiled = compileItemQuery(attributes, {
    where: withPlaceholderOperands(attributes, where),
    sort: [],
  })
  if (compiled.ok) return []
  // compileItemQuery's paths start at `where`.
  return compiled.errors.map((e) => ({ ...e, path: path + e.path.slice('where'.length) }))
}

/** Checks one measure: its attribute, that the type has the summary, and its `where`. */
export function checkMeasure(
  attributes: readonly Attribute[],
  measure: Measure,
  path: string,
  context: OperandContext,
): QueryError[] {
  const errors: QueryError[] = []
  const byId = new Map(attributes.map((a) => [a.id, a]))
  if (measure.attribute !== undefined) {
    const attribute = indexedAttribute(byId, measure.attribute, `${path}.attribute`, errors)
    if (attribute) {
      const summaries: readonly string[] = attributeTypes[attribute.type].summaries
      if (!summaries.includes(measure.fn)) {
        errors.push({
          path: `${path}.fn`,
          message: `${measure.fn} is not a summary of ${attribute.type} attribute "${attribute.id}"; use one of ${summaries.join(', ')}`,
        })
      }
    }
  }
  if (measure.where)
    errors.push(...checkFilter(attributes, measure.where, `${path}.where`, context))
  return errors
}

/**
 * Checks a parsed aggregate request against the attributes of its folder (`from`): `where`
 * and every measure's `where` as a query's, `$me` and `$now` allowed, `$block` only in views.
 * Returns every problem found.
 */
export function checkAggregate(
  attributes: readonly Attribute[],
  request: Pick<ParsedAggregateRequest, 'where' | 'groupBy' | 'measures'>,
  context: OperandContext = { blocks: false },
): QueryError[] {
  const errors: QueryError[] = []
  if (request.where) errors.push(...checkFilter(attributes, request.where, 'where', context))
  if (request.groupBy) errors.push(...checkGroupBy(attributes, request.groupBy, 'groupBy'))
  for (const [i, measure] of request.measures.entries()) {
    errors.push(...checkMeasure(attributes, measure, `measures.${String(i)}`, context))
  }
  return errors
}
