import { z } from 'zod'
import { cursorSchema, seqSchema } from './api.ts'
import { itemSchema } from './entities.ts'
import { noNul } from './nul.ts'

// Basic search (D70, #205): words in a hub's text attributes, bounded and under row-level
// security. `GET /v1/workspaces/:workspaceId/hubs/:hubId/search?q=&limit=&cursor=`. Served from
// #210; also the `search` MCP tool (mcp.ts). Rich text and comments wait for M6.

export const SEARCH_MIN_LENGTH = 2
export const SEARCH_MAX_LENGTH = 200
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 50

/** The words searched for: trimmed, then 2 to 200 characters. */
export const searchTextSchema = z
  .string()
  .trim()
  .min(SEARCH_MIN_LENGTH)
  .max(SEARCH_MAX_LENGTH)
  .refine(...noNul)

/** The fields of a search, as JSON (the MCP tool). */
export const searchFields = {
  q: searchTextSchema,
  limit: z.int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  cursor: cursorSchema.optional(),
}

/**
 * Query string. Matches items of the hub, in every folder, whose title or any other `text`
 * attribute contains `q` as a substring, ignoring case; `%` and `_` are plain characters. Title
 * matches (D50) rank first, then the most recently updated, then item ID. A hub the caller
 * can't read is 404.
 */
export const searchQuerySchema = z.strictObject({
  q: searchFields.q,
  limit: z.coerce.number().pipe(searchFields.limit.unwrap()).default(DEFAULT_SEARCH_LIMIT),
  cursor: searchFields.cursor,
})
export type SearchQuery = z.input<typeof searchQuerySchema>

/**
 * One page of matches, as of `seq` (D58). `nextCursor` continues the same ranking, and is
 * `null` on the last page.
 */
export const searchResultSchema = z.strictObject({
  items: z.array(itemSchema).max(MAX_SEARCH_LIMIT),
  nextCursor: cursorSchema.nullable(),
  seq: seqSchema,
})
export type SearchResult = z.infer<typeof searchResultSchema>
