import {
  attributeSchema,
  type Attribute,
  type Folder,
  type FolderAttribute,
  type Item,
  type PaletteColor,
  type Workspace,
} from '@16bit/core'
import type { Selectable } from 'kysely'
import type {
  AttributeTable,
  FolderAttributeTable,
  FolderTable,
  ItemTable,
  WorkspaceTable,
} from './db/database.ts'

// Database rows (snake_case) to the wire shapes in packages/core (camelCase).

export const toWorkspace = (row: Selectable<WorkspaceTable>): Workspace => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
})

export const toFolder = (row: Selectable<FolderTable>): Folder => ({
  workspaceId: row.workspace_id,
  id: row.id,
  hubId: row.hub_id,
  parentId: row.parent_id,
  name: row.name,
  // Guaranteed by the column's check constraint.
  color: row.color as PaletteColor,
  idPrefix: row.id_prefix,
  itemCount: row.item_count,
  version: row.version,
})

/** Parsed, so `config` is typed by `type` and gets its defaults. */
export const toAttribute = (row: Selectable<AttributeTable>): Attribute =>
  attributeSchema.parse({
    workspaceId: row.workspace_id,
    id: row.id,
    hubId: row.hub_id,
    name: row.name,
    type: row.type,
    config: row.config,
    indexed: row.indexed,
  })

export const toFolderAttribute = (row: Selectable<FolderAttributeTable>): FolderAttribute => ({
  workspaceId: row.workspace_id,
  hubId: row.hub_id,
  folderId: row.folder_id,
  attributeId: row.attribute_id,
  position: row.position,
  required: row.required,
})

export const toItem = (row: Selectable<ItemTable>): Item => ({
  workspaceId: row.workspace_id,
  id: row.id,
  hubId: row.hub_id,
  folderId: row.folder_id,
  seqId: row.seq_id,
  values: row.values,
  version: row.version,
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by,
})
