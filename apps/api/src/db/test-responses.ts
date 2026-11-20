import { itemWriteResultSchema, type Item } from '@16bit/core'

// Tests only. Item reads and writes carry the workspace `seq` (D58, #170); tests that compare
// items take it off, as the web store does (`withoutSeq`).

/** A plain item response (a write, or a read without `expand`), checked, without its `seq`. */
export function itemOf(body: unknown): Item {
  const item: Item & { seq?: number } = itemWriteResultSchema.parse(body)
  delete item.seq
  return item
}
