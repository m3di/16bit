import { z } from 'zod'
import { pageSchema } from './api.ts'
import { inviteSchema } from './auth.ts'
import {
  attributeTypes,
  freshForSchema,
  selectConfigSchema,
  selectOptionSchema,
  type SelectConfig,
} from './attribute-types/index.ts'
import {
  type Attribute,
  attributeSchema,
  attributeVariants,
  folderAttributeSchema,
  folderSchema,
  hubSchema,
  idSchema,
  principalSchema,
} from './entities.ts'
import { noNul } from './nul.ts'
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
// write sends the attribute's `version`. Both start at 0. A stale version is a 409 `conflict`
// whose `current` is the thing as it is now: the hub, the folder, the folder with its
// attributes (for the `PUT` of a folder's attributes only), or the attribute.

/** A name for a hub, folder or attribute. Trimmed; the stored shapes take 1 to 200 characters. */
export const schemaNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(...noNul)

/** The version the client last saw. Folders start at 0 (`folderSchema`). */
const folderVersionSchema = z.int().min(0)
/** Attributes start at 0, like folders (`attribute.version`, #111). */
const attributeVersionSchema = z.int().min(0)

const atLeastOneChange =
  (keys: readonly string[]) =>
  (body: Record<string, unknown>): boolean =>
    keys.some((k) => body[k] !== undefined)

// ----------------------------------------------------------------------------------------
// Hub

// `hubSchema` (the hub with its title attribute, D50) is in entities.ts, beside `folderSchema`.

/**
 * `PATCH /hubs/:hubId`, hub admins (`hub.rename`). Returns the hub (`hubSchema`). At least
 * one field besides `version`. `titleAttributeId` must name a `text` attribute of this hub
 * (400 otherwise), or `null` to clear it. `opensOnFolderId` (D76, `hub.manageSchema`) must
 * name a folder of this hub (400 otherwise), or `null` to open on the hub root.
 */
export const updateHubSchema = z
  .strictObject({
    version: folderVersionSchema,
    name: schemaNameSchema.optional(),
    color: paletteColorSchema.optional(),
    titleAttributeId: idSchema.nullable().optional(),
    opensOnFolderId: idSchema.nullable().optional(),
  })
  .refine(atLeastOneChange(['name', 'color', 'titleAttributeId', 'opensOnFolderId']), {
    message: 'At least one of name, color, titleAttributeId or opensOnFolderId is required',
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
 * Returns 201 with the folder. `viewsOnly` makes a folder that holds no items and only shows
 * its root view (D76); it is fixed at creation.
 */
export const createFolderSchema = z.strictObject({
  id: idSchema.optional(),
  parentId: idSchema,
  name: schemaNameSchema,
  color: paletteColorSchema,
  /** Absent is false. */
  viewsOnly: z.boolean().optional(),
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
 * `PATCH /attributes/:attributeId`: only the name, for select and multi-select the options,
 * and for a date its `freshFor` (D51, D69). Nothing else is accepted: a `type` or `config` key
 * is a 400. To change a type or a relation's target, add a new attribute.
 *
 * `freshFor` sets a date attribute's freshness, `null` clears it (#205). No value changes, so
 * it strips nothing and needs no `confirm`; a stored view filtering `is_stale` on it answers
 * `invalid` for that block once it is cleared (D79).
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
    freshFor: freshForSchema.nullable().optional(),
    confirm: z.int().min(0).optional(),
  })
  .refine(atLeastOneChange(['name', 'options', 'freshFor']), {
    message: 'At least one of name, options or freshFor is required',
  })
export type UpdateAttribute = z.infer<typeof updateAttributeSchema>

/**
 * Query string of `DELETE /attributes/:attributeId`. 204 on success. If items hold a value for
 * it, `confirm` must be their number, as with `updateAttributeSchema`. The values are stripped
 * from those items with a revision each, the attribute leaves every folder, and if it was the
 * hub's title attribute the hub's `titleAttributeId` becomes `null` (D50).
 */
export const deleteAttributeQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(0),
  confirm: z.coerce.number().int().min(0).optional(),
})
export type DeleteAttributeQuery = z.infer<typeof deleteAttributeQuerySchema>

/**
 * `GET /attributes/:attributeId/usage` (`hub.manageSchema`), select and multi-select only (400
 * otherwise): for each of the attribute's options, in option order, the number of the hub's
 * items that hold it, zero included. `version` is the attribute's, so a client can tell whether
 * the counts belong to the options it shows. For the options editor (D51).
 *
 * Counts are per option and do not add up across a multi-select's options: an item holding
 * several counts once under each. Removing one option affects exactly its `items`; removing
 * several affects each item once, so `confirm_required.affected` can be less than their sum.
 * Always send `affected` from the 409 as `confirm`, never a sum of these counts.
 */
export const attributeUsageSchema = z.strictObject({
  attributeId: idSchema,
  version: attributeVersionSchema,
  options: z
    .array(z.strictObject({ optionId: selectOptionSchema.shape.id, items: z.int().min(0) }))
    // As many as a select config holds (selectConfigSchema).
    .max(500),
})
export type AttributeUsage = z.infer<typeof attributeUsageSchema>

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
 * without them, invalid options (same rules as the type's config), and `freshFor` on anything
 * but a date.
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
  if (update.freshFor !== undefined) {
    if (next.type !== 'date') {
      return { ok: false, message: `A ${next.type} attribute has no freshFor` }
    }
    const config = { ...next.config }
    if (update.freshFor === null) delete config.freshFor
    else config.freshFor = update.freshFor
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
 * Checks and bumps the folder's `version`. Returns `folderAttributesResultSchema`, which says
 * how many items of the folder leave each required attribute empty.
 *
 * With `dryRun`, nothing is written and the version does not move: the response is what the
 * folder would look like, with the same counts, so settings can show them before saving (D51).
 * A stale `version` is still a 409.
 */
export const setFolderAttributesSchema = z.strictObject({
  version: folderVersionSchema,
  dryRun: z.boolean().default(false),
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

/**
 * The response of `PUT /folders/:folderId/attributes`: the folder and its attributes, plus
 * `requiredEmpty`, one entry per required attribute in list order, with the number of items in
 * this folder (not its subfolders) that hold no value for it (D51). Those items stay valid.
 */
export const folderAttributesResultSchema = folderAttributesSchema.extend({
  requiredEmpty: z
    .array(z.strictObject({ attributeId: idSchema, items: z.int().min(0) }))
    .max(MAX_FOLDER_ATTRIBUTES),
})
export type FolderAttributesResult = z.infer<typeof folderAttributesResultSchema>

// ----------------------------------------------------------------------------------------
// Grants and invites

/**
 * Whether an agent's key still works. The grant stays when its key is revoked or expires (D47),
 * so the grant list marks it instead of leaving it out. `revoked` wins over `expired`.
 */
export const AGENT_KEY_STATES = ['active', 'revoked', 'expired'] as const
export const agentKeyStateSchema = z.enum(AGENT_KEY_STATES)
export type AgentKeyState = z.infer<typeof agentKeyStateSchema>

const grantEntryFields = {
  principalId: idSchema,
  name: principalSchema.shape.name,
  workspaceRole: principalSchema.shape.workspaceRole,
  hubRole: hubRoleSchema,
}

/**
 * One entry of `GET /hubs/:hubId/grants` (`grant.list`: the hub's hub admins, and owners and
 * admins with or without a grant). Names and hub roles only, nothing inside the hub
 * (docs/ROLES.md). `hubRole` is the grant as stored; the effective role also depends on
 * `workspaceRole` (`effectiveHubRole`). Agents are listed too, under their key's name, with
 * `keyState` saying whether the key still works (#151); people have no `keyState`.
 */
export const hubGrantEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), ...grantEntryFields }),
  z.strictObject({ kind: z.literal('agent'), ...grantEntryFields, keyState: agentKeyStateSchema }),
])
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
