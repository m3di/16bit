import { z } from 'zod'
import {
  actorConfigSchema,
  autoIdConfigSchema,
  booleanConfigSchema,
  dateConfigSchema,
  multiSelectConfigSchema,
  numberConfigSchema,
  relationConfigSchema,
  richTextConfigSchema,
  richTextDocSchema,
  selectConfigSchema,
  textConfigSchema,
  urlConfigSchema,
} from './attribute-types/index.ts'
import { idSchema } from './ids.ts'
import { paletteColorSchema } from './palette.ts'

// Wire shapes shared by `apps/api` and `apps/web`: camelCase, timestamps as ISO strings,
// versions and counters as numbers. Columns are described in docs/ARCHITECTURE.md.

export { idSchema }
export const timestampSchema = z.iso.datetime({ offset: true })

export const workspaceSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(200),
  createdAt: timestampSchema,
})
export type Workspace = z.infer<typeof workspaceSchema>

export const PRINCIPAL_KINDS = ['user', 'agent'] as const
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer', 'finance'] as const

export const principalSchema = z.strictObject({
  workspaceId: idSchema,
  id: idSchema,
  kind: z.enum(PRINCIPAL_KINDS),
  name: z.string().min(1).max(200),
  workspaceRole: z.enum(WORKSPACE_ROLES),
})
export type Principal = z.infer<typeof principalSchema>

/** A hub is a folder with `parentId === null` and `hubId === id` (D2). */
export const folderSchema = z.strictObject({
  workspaceId: idSchema,
  id: idSchema,
  hubId: idSchema,
  parentId: idSchema.nullable(),
  name: z.string().min(1).max(200),
  color: paletteColorSchema,
  idPrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
  itemCount: z.int().min(0),
  version: z.int().min(0),
})
export type Folder = z.infer<typeof folderSchema>

const attributeBase = {
  workspaceId: idSchema,
  id: idSchema,
  hubId: idSchema,
  name: z.string().min(1).max(200),
  /** Copied into `item_index` for filter and sort (D6). */
  indexed: z.boolean(),
}

/**
 * One strict object per attribute type: `base` plus `type` and its typed `config`. Shared by
 * the stored attribute and the create request, so a type's config is declared once.
 */
export function attributeVariants<B extends z.core.$ZodLooseShape>(base: B) {
  return [
    z.strictObject({ ...base, type: z.literal('text'), config: textConfigSchema }),
    z.strictObject({ ...base, type: z.literal('number'), config: numberConfigSchema }),
    z.strictObject({ ...base, type: z.literal('boolean'), config: booleanConfigSchema }),
    z.strictObject({ ...base, type: z.literal('date'), config: dateConfigSchema }),
    z.strictObject({ ...base, type: z.literal('select'), config: selectConfigSchema }),
    z.strictObject({ ...base, type: z.literal('multi_select'), config: multiSelectConfigSchema }),
    z.strictObject({ ...base, type: z.literal('url'), config: urlConfigSchema }),
    z.strictObject({ ...base, type: z.literal('actor'), config: actorConfigSchema }),
    z.strictObject({ ...base, type: z.literal('auto_id'), config: autoIdConfigSchema }),
    z.strictObject({ ...base, type: z.literal('rich_text'), config: richTextConfigSchema }),
    z.strictObject({ ...base, type: z.literal('relation'), config: relationConfigSchema }),
  ] as const
}

/** Attributes belong to a hub (D10). `config` is typed by `type`. */
export const attributeSchema = z
  .discriminatedUnion('type', attributeVariants(attributeBase))
  .superRefine((attribute, ctx) => {
    // Relations stay inside their hub unless the attribute allows otherwise (D11).
    if (
      attribute.type === 'relation' &&
      !attribute.config.crossHub &&
      attribute.config.targetHubId !== attribute.hubId
    ) {
      ctx.addIssue({
        code: 'custom',
        message: "targetHubId must be the attribute's own hub unless crossHub is on",
        path: ['config', 'targetHubId'],
      })
    }
  })
export type Attribute = z.infer<typeof attributeSchema>

/** Places a hub attribute on a folder. `hubId` is the hub of both (D10). */
export const folderAttributeSchema = z.strictObject({
  workspaceId: idSchema,
  hubId: idSchema,
  folderId: idSchema,
  attributeId: idSchema,
  position: z.int().min(0),
  required: z.boolean(),
})
export type FolderAttribute = z.infer<typeof folderAttributeSchema>

/**
 * Stored item values, keyed by attribute ID (D5). `null` means the value was cleared. Lists
 * hold option, principal, or item IDs; an object is a rich text document. Each value is
 * checked against its attribute by `validateItemValues`.
 */
export const itemValuesSchema = z.record(
  idSchema,
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()), richTextDocSchema]),
)
export type ItemValues = z.infer<typeof itemValuesSchema>

export const itemSchema = z.strictObject({
  workspaceId: idSchema,
  id: idSchema,
  hubId: idSchema,
  folderId: idSchema,
  /** Per-hub sequence, shown with the folder's `idPrefix`, for example `BLD-12`. */
  seqId: z.int().min(1),
  values: itemValuesSchema,
  version: z.int().min(1),
  updatedAt: timestampSchema,
  updatedBy: idSchema,
})
export type Item = z.infer<typeof itemSchema>
