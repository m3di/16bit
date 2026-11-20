import { z } from 'zod'
import {
  attributeSchema,
  folderAttributeSchema,
  folderSchema,
  hubSchema,
  idSchema,
  itemSchema,
  principalSchema,
  timestampSchema,
  workspaceSchema,
} from './entities.ts'
import { decodeItemCursor, type ItemCursorOrder } from './cursor.ts'
import { paletteColorSchema } from './palette.ts'
import { boundedFilterSchema, expandSchema, sortSchema } from './query.ts'
import { agentHubRoleSchema, hubRoleSchema, workspaceRoleSchema } from './roles.ts'

// Request and response shapes of the HTTP API (v1), shared by `apps/api` and `apps/web`.
// Every route is scoped to a workspace: `/v1/workspaces/:workspaceId/...`.
// Values are checked twice: the shape here, then against the folder's attributes with
// `validateItemValues`.

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

/** An opaque cursor from a previous page's `nextCursor`. */
export const cursorSchema = z.string().min(1).max(512)

/**
 * A position in the workspace's change history: `revision.seq`, which only grows (D58). `0`
 * is before the first change.
 */
export const seqSchema = z.int().min(0)

/**
 * The workspace's `seq` as of a read: a client keeping the response live subscribes with it as
 * `after` (D58). It is never newer than the rows it came with. Optional until the API sends it
 * (M3-03); a client that gets none must not subscribe from that read.
 */
const responseSeq = { seq: seqSchema.optional() }

/**
 * A client's ID for one item write, so a retry is safe (D59). Unique per workspace and actor:
 * a retry with the same ID applies nothing and answers as the first attempt did, with the item
 * as it is now; the same ID with another item or operation is a 422.
 */
export const clientMutationIdSchema = z.uuid()

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

/**
 * One entry of the hub list. `granted`: the caller holds a grant on the hub; `hubRole` is their
 * effective hub role (the grant capped by workspace role, docs/ROLES.md). `none`: owners and
 * admins also see hubs they hold no grant on, by name only (D45). Everything inside such a hub
 * is a 404 to them until they grant themselves access.
 */
export const hubListEntrySchema = z.discriminatedUnion('access', [
  folderSchema.extend({ access: z.literal('granted'), hubRole: hubRoleSchema }),
  z.strictObject({
    access: z.literal('none'),
    workspaceId: idSchema,
    id: idSchema,
    name: folderSchema.shape.name,
    color: paletteColorSchema,
  }),
])
export type HubListEntry = z.infer<typeof hubListEntrySchema>

/** `GET /v1/workspaces/:workspaceId/hubs`: hubs by name. `itemCount` is the hub's total. */
export const hubPageSchema = pageSchema(hubListEntrySchema)

/**
 * `POST /v1/workspaces/:workspaceId/hubs`, owners and admins. The creator becomes the hub's
 * hub admin (docs/ROLES.md). `id` is optional; the server makes one if absent. Returns 201 with
 * the new hub as a `granted` hub list entry. An `idPrefix` another hub of the workspace has is
 * 409 `prefix_taken` (D56); an `id` a hub has or had is 409 `id_taken`.
 */
export const createHubSchema = z.strictObject({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(200),
  color: paletteColorSchema,
  idPrefix: folderSchema.shape.idPrefix,
})
export type CreateHub = z.input<typeof createHubSchema>

/**
 * `GET /v1/workspaces/:workspaceId/members`: the people of the workspace, by name. Agent
 * principals are listed through their keys, removed members not at all. Agents get 403.
 */
export const memberPageSchema = pageSchema(principalSchema)

/**
 * `PATCH /v1/workspaces/:workspaceId/members/:principalId`. Returns the member. An admin cannot
 * change an owner or make one, and the last owner cannot stop being one (docs/ROLES.md).
 * `DELETE` on the same path removes the member (204): their hub grants are revoked, their
 * unused invites expire, and they can no longer sign in to the workspace. The principal stays
 * so history keeps its actor; agent keys they created stay until revoked.
 */
export const changeMemberRoleSchema = z.strictObject({ workspaceRole: workspaceRoleSchema })
export type ChangeMemberRole = z.infer<typeof changeMemberRoleSchema>

/** A principal's access to one hub (D27). */
export const hubGrantSchema = z.strictObject({
  workspaceId: idSchema,
  hubId: idSchema,
  principalId: idSchema,
  hubRole: hubRoleSchema,
})
export type HubGrant = z.infer<typeof hubGrantSchema>

/**
 * `PUT /v1/workspaces/:workspaceId/hubs/:hubId/grants/:principalId`: grants or changes a
 * person's hub role and returns the grant. Owners and admins may grant themselves (self-grant,
 * D45). `DELETE` on the same path revokes (204, also when there was no grant). Agent grants
 * come and go with their keys. Every change is written to `access_log` (D48).
 */
export const setHubGrantSchema = z.strictObject({ hubRole: hubRoleSchema })
export type SetHubGrant = z.infer<typeof setHubGrantSchema>

/** `GET /v1/workspaces/:workspaceId/hubs/:hubId`: a hub with its folders and attributes. */
export const hubDescriptionSchema = z.strictObject({
  /** The hub, with its title attribute (D50). */
  hub: hubSchema,
  /**
   * The caller's effective role in this hub: their grant capped by their workspace role
   * (docs/ROLES.md), as in the hub list. Lets a client show read-only states before a 403.
   */
  hubRole: hubRoleSchema,
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
  ...responseSeq,
})
export type HubDescription = z.infer<typeof hubDescriptionSchema>

/** Most rows `offset` skips (D20, D61). */
export const MAX_QUERY_OFFSET = 100_000

/**
 * The order of a query without `sort` (D61): `updated` is newest update first, `number` is
 * item number, newest first. `number` keeps a row in place when it is edited, so a window
 * by offset stays put.
 */
export const ITEM_QUERY_ORDERS = ['updated', 'number'] as const
export type ItemQueryOrder = (typeof ITEM_QUERY_ORDERS)[number]

/**
 * `POST /v1/workspaces/:workspaceId/query`. The query shape in docs/ARCHITECTURE.md: items of
 * one folder, filtered and sorted on indexed attributes (D20), with a required limit. `where`,
 * `sort` and `expand` are checked against the folder's attributes with `compileItemQuery`.
 *
 * - Without `sort`, `order` decides: `updated` (the default) or `number` (D61). `order`
 *   together with a non-empty `sort` is refused.
 * - Paging is by `cursor` or by `offset` (0 to `MAX_QUERY_OFFSET`), never both. A cursor
 *   records the order it was read in (`updated`, `number`, or an attribute `sort`) and is
 *   refused under another; under `number` it pages by item number.
 * - `count: true` adds `total`, the number of items that pass `where`.
 */
export const itemQuerySchema = z
  .strictObject({
    from: idSchema,
    where: boundedFilterSchema.nullable().default(null),
    sort: sortSchema.default([]),
    order: z.enum(ITEM_QUERY_ORDERS).optional(),
    expand: expandSchema.default([]),
    limit: z.int().min(1).max(MAX_PAGE_LIMIT),
    cursor: cursorSchema.nullable().default(null),
    offset: z.int().min(0).max(MAX_QUERY_OFFSET).optional(),
    count: z.boolean().default(false),
  })
  .superRefine((query, ctx) => {
    if (query.order !== undefined && query.sort.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['order'],
        message: 'order cannot be combined with sort; sort decides the order',
      })
    }
    if (query.offset !== undefined && query.cursor !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['offset'],
        message: 'Page by offset or by cursor, not both',
      })
    }
    if (query.cursor !== null) {
      const cursor = decodeItemCursor(query.cursor)
      const order = itemQueryOrder(query)
      if (!cursor) {
        ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'Invalid cursor' })
      } else if (cursor.order !== order) {
        ctx.addIssue({
          code: 'custom',
          path: ['cursor'],
          message: `This cursor is from the ${cursor.order} order and cannot page the ${order} order`,
        })
      }
    }
  })
export type ItemQuery = z.input<typeof itemQuerySchema>
export type ParsedItemQuery = z.output<typeof itemQuerySchema>

/** The order a query's rows come in, as its cursors record it. */
export function itemQueryOrder(query: {
  sort?: readonly unknown[] | undefined
  order?: ItemQueryOrder | undefined
}): ItemCursorOrder {
  if (query.sort && query.sort.length > 0) return 'sort'
  return query.order ?? 'updated'
}

export const itemPageSchema = pageSchema(itemSchema)

/**
 * A linked item as the caller sees it. `none` means it exists but the caller cannot read it
 * (no grant on its hub, D27): its values are never sent (docs/ROLES.md, relations across hubs).
 */
export const linkedItemSchema = z.discriminatedUnion('access', [
  z.strictObject({ access: z.literal('read'), item: itemSchema }),
  z.strictObject({ access: z.literal('none') }),
])
export type LinkedItem = z.infer<typeof linkedItemSchema>

/** Most linked items one `POST /query` or `GET /items/:itemId` response carries in `linked`. */
export const MAX_LINKED_ITEMS = 1000

/**
 * The response of `POST /query`, with the workspace `seq` of the read (D58). With a non-empty `expand`, `linked` holds the items that page
 * items link to through the expanded attributes, keyed by item ID, by ID order, up to
 * `MAX_LINKED_ITEMS`. If `linkedTruncated` is false, an ID in an expanded relation value with no
 * entry in `linked` no longer exists. If it is true, such an ID may also have been cut off:
 * ask again with a lower `limit`.
 */
export const itemQueryResultSchema = itemPageSchema.extend({
  linked: z.record(idSchema, linkedItemSchema).optional(),
  linkedTruncated: z.boolean().optional(),
  /** With `count: true`: the items that pass `where`, over all pages (D61). */
  total: z.int().min(0).optional(),
  ...responseSeq,
})
export type ItemQueryResult = z.infer<typeof itemQueryResultSchema>

/**
 * One entry of `GET /v1/workspaces/:workspaceId/items/:itemId/backlinks`: `item` links to this
 * item through its relation attribute `attributeId`. Only items the caller can read are listed.
 */
export const backlinkSchema = z.strictObject({ attributeId: idSchema, item: itemSchema })
export type Backlink = z.infer<typeof backlinkSchema>

/** Most linking items `hidden` counts. */
export const MAX_HIDDEN_BACKLINKS = 1000

/**
 * Backlinks by linking item ID, then attribute ID. Takes `pageQuerySchema`. `hidden` counts the
 * links from items the caller cannot read, over all pages, up to `MAX_HIDDEN_BACKLINKS`. Their
 * IDs are never sent, so a hub the caller cannot see stays a 404 (docs/ROLES.md).
 */
export const backlinkPageSchema = pageSchema(backlinkSchema).extend({
  hidden: z.int().min(0).max(MAX_HIDDEN_BACKLINKS),
})
export type BacklinkPage = z.infer<typeof backlinkPageSchema>

/**
 * Query string of `GET /v1/workspaces/:workspaceId/items/:itemId`. `expand` names relation
 * attributes shown on the item's folder, as in `POST /query`: comma-separated
 * (`?expand=a,b`), repeated (`?expand=a&expand=b`), or both. Same rules: at most 3, each once.
 * An empty `?expand=` is the same as none.
 */
export const getItemQuerySchema = z.strictObject({
  expand: z
    .preprocess(
      (v) => (typeof v === 'string' ? [v] : v),
      // An empty value (`?expand=`, a joined empty list) asks for nothing; `a,,b` is refused.
      z.array(z.string()).transform((v) => v.filter((p) => p !== '').flatMap((p) => p.split(','))),
    )
    .pipe(expandSchema)
    .default([]),
})
export type GetItemQuery = z.input<typeof getItemQuerySchema>

/**
 * The response of `GET /items/:itemId`: the item, and with a non-empty `expand`, `linked` and
 * `linkedTruncated` with the same meaning as in `POST /query`. An ID in an expanded relation
 * value with no `linked` entry (and `linkedTruncated` false) no longer exists; `{ access:
 * "none" }` means it exists in a hub the caller cannot read. Without `expand`, the item and
 * `seq` (D58).
 */
export const itemReadSchema = itemSchema.extend({
  linked: z.record(idSchema, linkedItemSchema).optional(),
  linkedTruncated: z.boolean().optional(),
  ...responseSeq,
})
export type ItemRead = z.infer<typeof itemReadSchema>

/** Values as sent by a client, before they are checked against the folder's attributes. */
export const itemValuesInputSchema = z.record(idSchema, z.unknown())

/** `POST /v1/workspaces/:workspaceId/items`. `id` is optional; the server makes one if absent. */
export const createItemSchema = z.strictObject({
  id: idSchema.optional(),
  folderId: idSchema,
  values: itemValuesInputSchema.default({}),
  clientMutationId: clientMutationIdSchema.optional(),
})
export type CreateItem = z.input<typeof createItemSchema>

/**
 * `PATCH /v1/workspaces/:workspaceId/items/:itemId`. `version` is the version the client
 * last saw (D8). `values` is merged into the item; `null` clears a value.
 */
export const patchItemSchema = z.strictObject({
  version: z.int().min(1),
  clientMutationId: clientMutationIdSchema.optional(),
  values: itemValuesInputSchema.refine((v) => Object.keys(v).length > 0, {
    message: 'At least one value is required',
  }),
})
export type PatchItem = z.infer<typeof patchItemSchema>

/** Query string of `DELETE /v1/workspaces/:workspaceId/items/:itemId`. */
export const deleteItemQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(1),
  clientMutationId: clientMutationIdSchema.optional(),
})

/**
 * The response of `POST /items` (201) and `PATCH /items/:itemId`: the item as written, with the
 * workspace `seq` read inside the write's own transaction (D58). A retry with a known
 * `clientMutationId` answers the same way, with the item as it is now (D59).
 */
export const itemWriteResultSchema = itemSchema.extend(responseSeq)
export type ItemWriteResult = z.infer<typeof itemWriteResultSchema>

/**
 * An agent key (D47). `id` is the key's agent principal. Its hub and role are the principal's
 * one hub grant. The secret is never part of this shape: it is returned once, at creation.
 */
export const agentKeySchema = z.strictObject({
  workspaceId: idSchema,
  id: idSchema,
  name: z.string().min(1).max(200),
  hubId: idSchema,
  hubRole: agentHubRoleSchema,
  /** The principal who created the key. */
  createdBy: idSchema,
  createdAt: timestampSchema,
  /** `null`: the key does not expire. */
  expiresAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
})
export type AgentKey = z.infer<typeof agentKeySchema>

/**
 * `POST /v1/workspaces/:workspaceId/hubs/:hubId/agent-keys`. `hubRole` is at most the
 * creator's effective hub role. `expiresAt`, if set, must be in the future.
 */
export const createAgentKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  hubRole: agentHubRoleSchema,
  expiresAt: timestampSchema.nullable().default(null),
})
export type CreateAgentKey = z.input<typeof createAgentKeySchema>

/** The 201 response of creating a key. `secret` is shown this once and stored only hashed. */
export const createdAgentKeySchema = z.strictObject({
  key: agentKeySchema,
  /** Sent as `Authorization: Bearer <secret>`. */
  secret: z.string().min(1),
})
export type CreatedAgentKey = z.infer<typeof createdAgentKeySchema>

/** `GET /v1/workspaces/:workspaceId/hubs/:hubId/agent-keys`: newest first, revoked included. */
export const agentKeyPageSchema = pageSchema(agentKeySchema)

/** Every error response has this shape. Some codes add fields, listed below. */
export const API_ERROR_CODES = [
  /** No session or key, or a bad one. Also a failed sign-in. */
  'unauthorized',
  /** Signed in, but the role does not allow the action (docs/ROLES.md). */
  'forbidden',
  'not_found',
  'invalid_request',
  /** Adds `errors: ValueError[]` from `validateItemValues`. */
  'invalid_values',
  /**
   * Stale `version`. Adds `current`, the thing as it is now: an `Item` for item writes; for
   * schema writes see the conflict shapes in hub-settings.ts.
   */
  'conflict',
  /** `POST /items` with an `id` that is already used in the workspace. */
  'id_taken',
  /**
   * `POST /hubs` with an `idPrefix` another hub in the workspace has (D56). A deleted hub's
   * prefix is free again.
   */
  'prefix_taken',
  /** Accepting an invite as a new account with an email that already has one. */
  'email_taken',
  /** Accepting an invite into a workspace the account already belongs to. */
  'already_member',
  /** Deleting a folder or hub that still holds items or folders (D52). */
  'not_empty',
  /** Deleting a hub that a relation attribute in another hub targets (D52). */
  'in_use',
  /**
   * Removing an option or attribute that items use, without `confirm` or with a count that is
   * no longer right. Adds `affected: number`, the count now (D51).
   */
  'confirm_required',
  /** Too many attempts. The `Retry-After` header says when to try again, in seconds. */
  'rate_limited',
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
