import { z } from 'zod'
import {
  apiErrorSchema,
  clientMutationIdSchema,
  createItemSchema,
  itemCauseSchema,
  itemWriteResultSchema,
  patchItemFields,
  requireAChange,
  seqSchema,
  upsertItemSchema,
} from './api.ts'
import { idSchema } from './entities.ts'
import { externalKeySchema } from './external-key.ts'

// Batch writes (D65, #199): `POST /v1/workspaces/:workspaceId/items/batch`.

export const MAX_BATCH_OPERATIONS = 100

/** `POST /items`, as an operation. */
export const batchCreateSchema = createItemSchema.extend({ op: z.literal('create') })

/** `PATCH /items/:itemId`, as an operation: the item's ID is `id`. */
export const batchPatchSchema = requireAChange(
  z.strictObject({ op: z.literal('patch'), id: idSchema, ...patchItemFields }),
)

/** `DELETE /items/:itemId`, as an operation: the item's ID is `id`. */
export const batchDeleteSchema = z.strictObject({
  op: z.literal('delete'),
  id: idSchema,
  version: z.int().min(1),
  clientMutationId: clientMutationIdSchema.optional(),
  cause: itemCauseSchema.optional(),
})

/** `PUT /hubs/:hubId/items/by-key/:key`, as an operation: the path's parts are `hubId` and `key`. */
export const batchUpsertSchema = upsertItemSchema.extend({
  op: z.literal('upsert'),
  hubId: idSchema,
  key: externalKeySchema,
})

export const batchOperationSchema = z.discriminatedUnion('op', [
  batchCreateSchema,
  batchPatchSchema,
  batchDeleteSchema,
  batchUpsertSchema,
])
export type BatchOperation = z.input<typeof batchOperationSchema>

/**
 * The batch call (D65): 1 to 100 item writes, each the same as its single-item route, with its
 * own `clientMutationId`, `cause` and, for patch and upsert, `condition` (D66).
 *
 * - The body is checked whole at the edge: one malformed operation is a 400 for the batch, with
 *   the path naming it (`operations.3.values`), and nothing runs. Two operations with the same
 *   `clientMutationId` are refused the same way.
 * - Operations run in order, each in its own transaction, so one failure does not fail the
 *   rest, and no transaction holds the workspace row for the whole batch.
 * - Relation values may name an item by key (`relationKeyRefSchema`), including one an earlier
 *   operation created.
 * - A retry of the whole batch is safe where each operation carries a `clientMutationId`: each
 *   answers as its first attempt did (D59).
 */
export const batchRequestSchema = z.strictObject({
  operations: z
    .array(batchOperationSchema)
    .min(1)
    .max(MAX_BATCH_OPERATIONS)
    .superRefine((operations, ctx) => {
      const seen = new Map<string, number>()
      for (const [i, operation] of operations.entries()) {
        const id = operation.clientMutationId
        if (id === undefined) continue
        const first = seen.get(id)
        if (first === undefined) seen.set(id, i)
        else {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'clientMutationId'],
            message: `Operation ${String(first)} already uses this clientMutationId`,
          })
        }
      }
    }),
})
export type BatchRequest = z.input<typeof batchRequestSchema>
export type ParsedBatchRequest = z.output<typeof batchRequestSchema>

/** A create, patch or upsert that wrote (or a retry of one): the status its route answers. */
export const batchWrittenSchema = z.strictObject({
  status: z.union([z.literal(200), z.literal(201)]),
  item: itemWriteResultSchema,
})

/** A delete that removed the item (or a retry of one), with its revision's `seq` (D58). */
export const batchDeletedSchema = z.strictObject({
  status: z.literal(204),
  seq: seqSchema,
})

/**
 * An operation that failed: the status and error body its route would answer, for example
 * 409 with `{ error: "conflict", current }`, 412 `precondition_failed`, 422 `invalid_values`
 * with `errors`, or 404.
 */
export const batchFailedSchema = z.strictObject({
  status: z.int().min(400).max(599),
  error: apiErrorSchema,
})

export const batchResultSchema = z.union([
  batchWrittenSchema,
  batchDeletedSchema,
  batchFailedSchema,
])
export type BatchResult = z.infer<typeof batchResultSchema>

/**
 * The 200 answer of the batch call: one result per operation, in the same order. Only a request
 * that fails as a whole (authentication, a malformed body, rate limits) answers otherwise.
 */
export const batchResponseSchema = z.strictObject({
  results: z.array(batchResultSchema).min(1).max(MAX_BATCH_OPERATIONS),
})
export type BatchResponse = z.infer<typeof batchResponseSchema>
