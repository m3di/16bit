import { z } from 'zod'
import { timeZoneSchema } from './aggregate.ts'
import { seqSchema } from './api.ts'
import { utf8ByteLength } from './cursor.ts'

// The digest (D21, D86): a folder's root view rendered as compact Markdown for a model to read,
// `GET /v1/workspaces/:workspaceId/folders/:folderId/view/digest?version=&tz=`. It is the view
// data of D83 (one snapshot, the deadline, the in-flight count, row-level security) turned into
// text, so an agent gets in one call what a person sees on the page. Served from M5-02.

/** The most a digest's `markdown` holds, in UTF-8 bytes. */
export const MAX_DIGEST_BYTES = 32 * 1024

/**
 * Query string. `version` is optional, unlike view data's (D86): without it the digest renders
 * the view as it is; with it, a stored tree that moved past it is 409 `stale` with the version
 * now (`staleErrorSchema`). `tz` as in D81: UTC when absent, 422 `invalid_time_zone` when
 * unknown. A hidden or missing folder is 404; past the in-flight count, 429 `rate_limited`,
 * shared with view data and aggregates.
 */
export const digestQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(0).optional(),
  tz: timeZoneSchema.optional(),
})
export type DigestQuery = z.input<typeof digestQuerySchema>

/**
 * The digest, as of `seq` (D58), rendered from the tree at `version` (`0` for the default
 * view).
 *
 * Rendering, block by block: headings and section titles become Markdown headings; a number
 * block one line ("Points done: 16 of 34"); list and table rows one line each
 * ("- PT-12 Title · Stage: In QA · Points: 3"); a board one list per column; a chart a small
 * table of its series; a block's `error`, `invalid`, `not_found` or `unresolved` status one line
 * saying so. "+N more" is kept, and a date past its attribute's `freshFor` gets " (stale)"
 * (D69).
 *
 * `markdown` is at most `MAX_DIGEST_BYTES`. Past that it is cut after the last whole block
 * that fits, and `truncated` is true.
 */
export const digestSchema = z.strictObject({
  seq: seqSchema,
  version: z.int().min(0),
  markdown: z.string().refine((text) => utf8ByteLength(text) <= MAX_DIGEST_BYTES, {
    message: `At most ${String(MAX_DIGEST_BYTES / 1024)} KiB of UTF-8`,
  }),
  truncated: z.boolean(),
})
export type Digest = z.infer<typeof digestSchema>
