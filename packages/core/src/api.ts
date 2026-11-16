import { z } from 'zod'
import {
  attributeSchema,
  folderAttributeSchema,
  folderSchema,
  idSchema,
  itemSchema,
  workspaceSchema,
} from './entities.ts'

// Request and response shapes of the HTTP API (v1), shared by `apps/api` and `apps/web`.
// Every route is scoped to a workspace: `/v1/workspaces/:workspaceId/...`.
// Values are checked twice: the shape here, then against the folder's attributes with
// `validateItemValues`.

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

/** An opaque cursor from a previous page's `nextCursor`. */
export const cursorSchema = z.string().min(1).max(512)

/** Query string of the list endpoints (workspaces, hubs). */
export const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: cursorSchema.optional(),
})
export type PageQuery = z.infer<typeof pageQuerySchema>

/** One page of a list. `nextCursor` is `null` on the last page. */
export function pageSchema<T extends z.ZodType>(entry: T) {
  return z.strictObject({ items: z.array(entry), nextCursor: cursorSchema.nullable() })
}
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/** `GET /v1/workspaces`: the workspaces the caller belongs to, by name. */
export const workspacePageSchema = pageSchema(workspaceSchema)

/** `GET /v1/workspaces/:workspaceId/hubs`: hubs by name. `itemCount` is the hub's total. */
export const hubPageSchema = pageSchema(folderSchema)

/** `GET /v1/workspaces/:workspaceId/hubs/:hubId`: a hub with its folders and attributes. */
export const hubDescriptionSchema = z.strictObject({
  hub: folderSchema,
  /** Every folder in the hub except the hub itself, by name. */
  folders: z.array(folderSchema),
  attributes: z.array(attributeSchema),
  /** Which attributes each folder shows, in `position` order per folder. */
  folderAttributes: z.array(folderAttributeSchema),
  /** Each list is capped by the server. `true` means that list was cut off at the cap. */
  truncated: z.strictObject({
    folders: z.boolean(),
    attributes: z.boolean(),
    folderAttributes: z.boolean(),
  }),
})
export type HubDescription = z.infer<typeof hubDescriptionSchema>

/**
 * `POST /v1/workspaces/:workspaceId/query`. The M0 subset of the query shape in
 * docs/ARCHITECTURE.md: one folder, newest update first. Filters and sorts arrive in M1.
 */
export const itemQuerySchema = z.strictObject({
  from: idSchema,
  limit: z.int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: cursorSchema.nullable().default(null),
})
export type ItemQuery = z.input<typeof itemQuerySchema>

export const itemPageSchema = pageSchema(itemSchema)

/** Values as sent by a client, before they are checked against the folder's attributes. */
export const itemValuesInputSchema = z.record(idSchema, z.unknown())

/** `POST /v1/workspaces/:workspaceId/items`. `id` is optional; the server makes one if absent. */
export const createItemSchema = z.strictObject({
  id: idSchema.optional(),
  folderId: idSchema,
  values: itemValuesInputSchema.default({}),
})
export type CreateItem = z.input<typeof createItemSchema>

/**
 * `PATCH /v1/workspaces/:workspaceId/items/:itemId`. `version` is the version the client
 * last saw (D8). `values` is merged into the item; `null` clears a value.
 */
export const patchItemSchema = z.strictObject({
  version: z.int().min(1),
  values: itemValuesInputSchema.refine((v) => Object.keys(v).length > 0, {
    message: 'At least one value is required',
  }),
})
export type PatchItem = z.infer<typeof patchItemSchema>

/** Query string of `DELETE /v1/workspaces/:workspaceId/items/:itemId`. */
export const deleteItemQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(1),
})

/** Every error response has this shape. Some codes add fields, listed below. */
export const API_ERROR_CODES = [
  'unauthorized',
  'not_found',
  'invalid_request',
  /** Adds `errors: ValueError[]` from `validateItemValues`. */
  'invalid_values',
  /** Stale `version`. Adds `current: Item`, the item as it is now. */
  'conflict',
  /** `POST /items` with an `id` that is already used in the workspace. */
  'id_taken',
  'internal',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export const apiErrorSchema = z.looseObject({
  error: z.enum(API_ERROR_CODES),
  message: z.string(),
})
export type ApiError = z.infer<typeof apiErrorSchema>

export const conflictErrorSchema = z.strictObject({
  error: z.literal('conflict'),
  message: z.string(),
  current: itemSchema,
})
export type ConflictError = z.infer<typeof conflictErrorSchema>
