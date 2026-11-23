import type { BatchResult, ParsedBatchRequest } from '@16bit/core'
import { HttpError } from './http.ts'
import {
  createWrite,
  deleteWrite,
  patchWrite,
  upsertWrite,
  type WriteContext,
} from './item-writes.ts'
import { rerunOnKeyRace } from './items.ts'

// Batch writes (D65, #202): `POST /v1/workspaces/:workspaceId/items/batch`. The body is checked
// whole at the edge (`batchRequestSchema`, 400 for the batch). Then each operation runs in
// order, in its own transaction, through exactly the code of its single-item route
// (item-writes.ts), so it checks the grant, takes the same locks, records its mutation ID and
// sends its own NOTIFY. No transaction spans the batch, so it never holds the workspace row
// (the revision `seq`) for more than one operation. A failure is that operation's result, as
// its route would have answered it, and the next operation runs. `{ externalKey }` references
// in relation values resolve when their operation runs, so an item an earlier operation created
// (and committed) is found.

type Operation = ParsedBatchRequest['operations'][number]

/** The status and body a failed operation's route would have answered. */
function failure(error: unknown): BatchResult {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      error: { ...error.extra, error: error.code, message: error.message },
    }
  }
  console.error(error)
  return { status: 500, error: { error: 'internal', message: 'Internal error' } }
}

async function runOne(ctx: WriteContext, operation: Operation): Promise<BatchResult> {
  // Each operation is its route's body plus `op` (and the path's parts), which the writes ignore.
  switch (operation.op) {
    case 'create':
      return { status: 201, item: await createWrite(ctx, operation) }
    case 'patch':
      return { status: 200, item: await patchWrite(ctx, operation.id, operation) }
    case 'delete': {
      const { seq } = await deleteWrite(ctx, operation.id, operation)
      return { status: 204, seq }
    }
    case 'upsert': {
      const { hubId, key } = operation
      const { created, result } = await rerunOnKeyRace(() =>
        upsertWrite(ctx, hubId, key, operation),
      )
      return { status: created ? 201 : 200, item: result }
    }
  }
}

/** Runs the operations in order, each on its own; one result per operation, in order. */
export async function runBatch(
  ctx: Omit<WriteContext, 'keyRefs'>,
  operations: readonly Operation[],
): Promise<BatchResult[]> {
  const results: BatchResult[] = []
  for (const operation of operations) {
    try {
      results.push(await runOne({ ...ctx, keyRefs: true }, operation))
    } catch (error) {
      results.push(failure(error))
    }
  }
  return results
}
