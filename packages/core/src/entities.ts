import { z } from 'zod'
import {
  booleanConfigSchema,
  dateConfigSchema,
  numberConfigSchema,
  selectConfigSchema,
  textConfigSchema,
} from './attribute-types/index.ts'
import { paletteColorSchema } from './palette.ts'

// Wire shapes shared by `apps/api` and `apps/web`: camelCase, timestamps as ISO strings,
// versions and counters as numbers. Columns are described in docs/ARCHITECTURE.md.

/**
 * Safe as a JSONB key, an object key, and in URLs. `__proto__` passes the character set
 * but would be dropped when assigned to a plain object, so it is rejected by name.
 */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((id) => id !== '__proto__', { message: 'Reserved ID' })
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

/** Attributes belong to a hub (D10). `config` is typed by `type`. */
export const attributeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...attributeBase, type: z.literal('text'), config: textConfigSchema }),
  z.strictObject({ ...attributeBase, type: z.literal('number'), config: numberConfigSchema }),
  z.strictObject({ ...attributeBase, type: z.literal('boolean'), config: booleanConfigSchema }),
  z.strictObject({ ...attributeBase, type: z.literal('date'), config: dateConfigSchema }),
  z.strictObject({ ...attributeBase, type: z.literal('select'), config: selectConfigSchema }),
])
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

/** Stored item values, keyed by attribute ID (D5). `null` means the value was cleared. */
export const itemValuesSchema = z.record(
  idSchema,
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
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
