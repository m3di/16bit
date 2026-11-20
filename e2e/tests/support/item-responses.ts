import { itemReadSchema, itemWriteResultSchema, type Item } from '@16bit/core'

// Item responses carry the workspace `seq` from M3-03 (D58), which the strict `itemSchema`
// refuses. Specs compare items, so these parse with the schemas that allow it and drop it
// (issue 168).

function withoutSeq<T extends { seq?: number | undefined }>(response: T): Omit<T, 'seq'> {
  const rest = { ...response }
  delete rest.seq
  return rest
}

/** The body of `GET /items/:itemId` without `expand`. */
export function parseItemRead(body: unknown): Item {
  const { linked, linkedTruncated, ...item } = withoutSeq(itemReadSchema.parse(body))
  if (linked !== undefined || linkedTruncated !== undefined) {
    throw new Error('Expected an item read without expand')
  }
  return item
}

/** The body of `POST /items` or `PATCH /items/:itemId`. */
export function parseItemWrite(body: unknown): Item {
  return withoutSeq(itemWriteResultSchema.parse(body))
}
