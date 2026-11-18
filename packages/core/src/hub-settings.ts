import { z } from 'zod'
import { pageSchema } from './api.ts'
import { inviteSchema } from './auth.ts'
import { attributeTypes, selectConfigSchema, type SelectConfig } from './attribute-types/index.ts'
import {
  type Attribute,
  attributeSchema,
  attributeVariants,
  folderAttributeSchema,
  folderSchema,
  idSchema,
  principalSchema,
} from './entities.ts'
import { paletteColorSchema } from './palette.ts'
import { hubRoleSchema } from './roles.ts'

// Schema writes for hub settings (M2): the hub itself, its folders and attributes, which
// attributes each folder shows, who holds a grant, and the workspace's pending invites.
// Routes are under `/v1/workspaces/:workspaceId`. Who may do what is `can()` in roles.ts:
// `hub.rename` for the hub, `hub.manageSchema` for folders and attributes, `hub.delete`,
// `grant.list`, and `relation.target` for a relation into another hub.
//
// Versions (D8 for schema): a hub or folder write sends the folder's `version`; so does any
// change to the attributes a folder shows (one `PUT` replaces the whole list). An attribute
// write sends the attribute's `version`. A stale version is a 409 `conflict` whose `current`
// is the hub, folder (with its attributes) or attribute as it is now.

/** A name for a hub, folder or attribute. Trimmed; the stored shapes take 1 to 200 characters. */
export const schemaNameSchema = z.string().trim().min(1).max(200)

/** The version the client last saw. Folders start at 0 (`folderSchema`). */
const folderVersionSchema = z.int().min(0)
/** Attributes start at 1, like items. */
const attributeVersionSchema = z.int().min(1)

const atLeastOneChange =
  (keys: readonly string[]) =>
  (body: Record<string, unknown>): boolean =>
    keys.some((k) => body[k] !== undefined)

// ----------------------------------------------------------------------------------------
// Hub

/**
 * A hub as hub settings sees it: a folder with no parent (D2) and its title attribute (D50).
 * `titleAttributeId` names one of the hub's `text` attributes, or `null` for none, in which
 * case items show only their mono ID. It is cleared when that attribute is removed.
 */
export const hubSchema = folderSchema.extend({
  parentId: z.null(),
  titleAttributeId: idSchema.nullable(),
})
export type Hub = z.infer<typeof hubSchema>

/**
 * `PATCH /hubs/:hubId`, hub admins (`hub.rename`). Returns the hub (`hubSchema`). At least
 * one field besides `version`. `titleAttributeId` must name a `text` attribute of this hub
 * (400 otherwise), or `null` to clear it.
 */
export const updateHubSchema = z
  .strictObject({
    version: folderVersionSchema,
    name: schemaNameSchema.optional(),
    color: paletteColorSchema.optional(),
    titleAttributeId: idSchema.nullable().optional(),
  })
  .refine(atLeastOneChange(['name', 'color', 'titleAttributeId']), {
    message: 'At least one of name, color or titleAttributeId is required',
  })
export type UpdateHub = z.infer<typeof updateHubSchema>

/**
 * Query string of `DELETE /hubs/:hubId` (owners and admins with a grant on the hub, D52) and
 * `DELETE /folders/:folderId` (`hub.manageSchema`). 204 on success.
 *
 * - Not empty (any item or folder in it): 409 `not_empty`.
 * - A hub that a relation attribute in another hub targets: 409 `in_use`.
 * - An admin deleting a hub an owner holds a grant on: 403 (docs/ROLES.md footnote 1).
 *
 * Deleting a hub revokes its agent keys and deletes its grants and attributes, logged in
 * `access_log`. A hub is never deleted through the folder route.
 */
export const deleteFolderQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(0),
})
export type DeleteFolderQuery = z.infer<typeof deleteFolderQuerySchema>

// ----------------------------------------------------------------------------------------
// Folders

/**
 * `POST /hubs/:hubId/folders`. `parentId` is the hub or a folder in it. `id` is optional; the
 * server makes one if absent. A folder takes its hub's `idPrefix` (item numbers are per hub).
 * Returns 201 with the folder.
 */
export const createFolderSchema = z.strictObject({
  id: idSchema.optional(),
  parentId: idSchema,
  name: schemaNameSchema,
  color: paletteColorSchema,
})
export type CreateFolder = z.input<typeof createFolderSchema>

/**
 * `PATCH /folders/:folderId`: rename, recolour or move a folder (not a hub: use `PATCH
 * /hubs/:hubId`). A new `parentId` must be the hub or a folder of the same hub, and not the
 * folder itself or one of its descendants (400). Returns the folder.
 */
export const updateFolderSchema = z
  .strictObject({
    version: folderVersionSchema,
    name: schemaNameSchema.optional(),
    color: paletteColorSchema.optional(),
    parentId: idSchema.optional(),
  })
  .refine(atLeastOneChange(['name', 'color', 'parentId']), {
    message: 'At least one of name, color or parentId is required',
  })
export type UpdateFolder = z.infer<typeof updateFolderSchema>

// ----------------------------------------------------------------------------------------
// Attributes

const createAttributeBase = {
  id: idSchema.optional(),
  name: schemaNameSchema,
  /** Copied into `item_index` for filter and sort (D6). */
  indexed: z.boolean().default(false),
}

/**
 * `POST /hubs/:hubId/attributes`. The type and its config, as in `attributeSchema`; the server
 * adds the workspace and hub and checks the result with `attributeSchema`, so a relation with
 * `crossHub` off must target this hub. A relation into another hub needs `crossHub` on and
 * `relation.target` on that hub (at least viewer access there; otherwise 404, as for any hub
 * the caller cannot see). Returns 201 with the attribute.
 *
 * The type, a relation's `targetHubId` and its `crossHub` never change afterwards (D51).
 */
export const createAttributeSchema = z.discriminatedUnion(
  'type',
  attributeVariants(createAttributeBase),
)
export type CreateAttribute = z.input<typeof createAttributeSchema>

/**
 * `PATCH /attributes/:attributeId`: only the name and, for select and multi-select, the
 * options (D51). Nothing else is accepted: a `type` or `config` key is a 400. To change a type
 * or a relation's target, add a new attribute.
 *
 * `options` replaces the whole list (`applyAttributeUpdate`). Options may be relabelled,
 * recoloured, reordered, added or removed. If removing options would change items that hold
 * them, `confirm` must be the number of those items (`affected` from the 409
 * `confirm_required` the same request got without it, or with a stale count). The values are
 * stripped from those items in the same transaction, each with a revision.
 */
export const updateAttributeSchema = z
  .strictObject({
    version: attributeVersionSchema,
    name: schemaNameSchema.optional(),
    options: selectConfigSchema.shape.options.optional(),
    confirm: z.int().min(0).optional(),
  })
  .refine(atLeastOneChange(['name', 'options']), {
    message: 'At least one of name or options is required',
  })
export type UpdateAttribute = z.infer<typeof updateAttributeSchema>

/**
 * Query string of `DELETE /attributes/:attributeId`. 204 on success. If items hold a value for
 * it, `confirm` must be their number, as with `updateAttributeSchema`. The values are stripped
 * from those items with a revision each, the attribute leaves every folder, and if it was the
 * hub's title attribute the hub's `titleAttributeId` becomes `null` (D50).
 */
export const deleteAttributeQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(1),
  confirm: z.coerce.number().int().min(0).optional(),
})
export type DeleteAttributeQuery = z.infer<typeof deleteAttributeQuerySchema>

export type ApplyAttributeUpdateResult =
  | {
      ok: true
      /** The attribute after the update. */
      attribute: Attribute
      /** Option IDs the update removes. Items holding one are the affected items. */
      removedOptionIds: string[]
    }
  | { ok: false; message: string }

/**
 * Applies a checked `updateAttributeSchema` body to an attribute, for the server before the
 * write and for a client to know which options a change removes. Refuses `options` on a type
 * without them, and invalid options (same rules as the type's config).
 */
export function applyAttributeUpdate(
  attribute: Attribute,
  update: UpdateAttribute,
): ApplyAttributeUpdateResult {
  let next: Attribute = update.name === undefined ? attribute : { ...attribute, name: update.name }
  let removedOptionIds: string[] = []
  if (update.options !== undefined) {
    if (next.type !== 'select' && next.type !== 'multi_select') {
      return { ok: false, message: `A ${next.type} attribute has no options` }
    }
    const parsed = attributeTypes[next.type].configSchema.safeParse({
      ...next.config,
      options: update.options,
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { ok: false, message: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}` }
    }
    const config: SelectConfig = parsed.data
    const kept = new Set(config.options.map((o) => o.id))
    removedOptionIds = next.config.options.map((o) => o.id).filter((id) => !kept.has(id))
    next = { ...next, config }
  }
  return { ok: true, attribute: next, removedOptionIds }
}

// ----------------------------------------------------------------------------------------
// Which attributes a folder shows

/** Most attributes one folder shows. */
export const MAX_FOLDER_ATTRIBUTES = 200

/**
 * `PUT /folders/:folderId/attributes` (the hub's own ID for the hub): the attributes the
 * folder shows, in order, each with `required`. This one call attaches, detaches, reorders
 * and sets `required`; positions are the list order. Each must be an attribute of the folder's
 * hub (400). Detaching keeps item values; it only stops showing them. A newly required
 * attribute that existing items leave empty is allowed, and those items stay valid (D51).
 * Checks and bumps the folder's `version`. Returns `folderAttributesSchema`.
 */
export const setFolderAttributesSchema = z.strictObject({
  version: folderVersionSchema,
  attributes: z
    .array(z.strictObject({ attributeId: idSchema, required: z.boolean().default(false) }))
    .max(MAX_FOLDER_ATTRIBUTES)
    .refine((list) => new Set(list.map((a) => a.attributeId)).size === list.length, {
      message: 'Each attribute may appear once',
    }),
})
export type SetFolderAttributes = z.input<typeof setFolderAttributesSchema>

/**
 * A folder with the attributes it shows, in `position` order. The response of `PUT
 * /folders/:folderId/attributes` and the `current` of its 409 `conflict`.
 */
export const folderAttributesSchema = z.strictObject({
  folder: folderSchema,
  attributes: z.array(folderAttributeSchema).max(MAX_FOLDER_ATTRIBUTES),
})
export type FolderAttributes = z.infer<typeof folderAttributesSchema>

// ----------------------------------------------------------------------------------------
// Grants and invites

/**
 * One entry of `GET /hubs/:hubId/grants` (`grant.list`: the hub's hub admins, and owners and
 * admins with or without a grant). Names and hub roles only, nothing inside the hub
 * (docs/ROLES.md). `hubRole` is the grant as stored; the effective role also depends on
 * `workspaceRole` (`effectiveHubRole`). Agents are listed too, under their key's name.
 */
export const hubGrantEntrySchema = z.strictObject({
  principalId: idSchema,
  kind: principalSchema.shape.kind,
  name: principalSchema.shape.name,
  workspaceRole: principalSchema.shape.workspaceRole,
  hubRole: hubRoleSchema,
})
export type HubGrantEntry = z.infer<typeof hubGrantEntrySchema>

/** `GET /hubs/:hubId/grants`, by name then principal ID. Takes `pageQuerySchema`. */
export const hubGrantPageSchema = pageSchema(hubGrantEntrySchema)

/**
 * `GET /invites`, owners and admins: pending invites (not used, not expired, not revoked),
 * newest first. Takes `pageQuerySchema`. `POST /invites/:inviteId/revoke` ends one (204, also
 * when it already ended) and writes `invite.revoke` to `access_log` (D48). A revoked invite is
 * a 404 to whoever redeems it, like a used one.
 */
export const invitePageSchema = pageSchema(inviteSchema)

// ----------------------------------------------------------------------------------------
// Errors

/**
 * 409 `confirm_required`: the write would remove values from `affected` items and `confirm`
 * was missing or a different number. Show the count, then send it back as `confirm`.
 */
export const confirmRequiredErrorSchema = z.strictObject({
  error: z.literal('confirm_required'),
  message: z.string(),
  affected: z.int().min(1),
})
export type ConfirmRequiredError = z.infer<typeof confirmRequiredErrorSchema>

/** 409 `conflict` with the thing as it is now, for schema writes with a stale `version`. */
function schemaConflictSchema<T extends z.ZodType>(current: T) {
  return z.strictObject({ error: z.literal('conflict'), message: z.string(), current })
}

/** Stale `version` on `PATCH` or `DELETE /hubs/:hubId`. */
export const hubConflictErrorSchema = schemaConflictSchema(hubSchema)
/** Stale `version` on `PATCH` or `DELETE /folders/:folderId`. */
export const folderConflictErrorSchema = schemaConflictSchema(folderSchema)
/** Stale `version` on `PUT /folders/:folderId/attributes`. */
export const folderAttributesConflictErrorSchema = schemaConflictSchema(folderAttributesSchema)
/** Stale `version` on `PATCH` or `DELETE /attributes/:attributeId`. */
export const attributeConflictErrorSchema = schemaConflictSchema(attributeSchema)
