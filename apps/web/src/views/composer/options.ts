import { attributeTypes, type Attribute, type AttributeTypeName } from '@16bit/core'
import type { ComposerSchema } from './tree.ts'

// Choices the pickers offer, from the hub's schema. Only what core accepts for each use is
// offered: indexed attributes where filtered, sorted, grouped or summarised (D79).

export interface AttributeNeeds {
  types?: readonly AttributeTypeName[]
  indexed?: boolean
  sortable?: boolean
}

export function attributesFor(
  schema: ComposerSchema,
  folderId: string,
  needs: AttributeNeeds = {},
): Attribute[] {
  return schema
    .attributesOf(folderId)
    .filter(
      (a) =>
        (!needs.types || needs.types.includes(a.type)) &&
        (!needs.indexed || a.indexed) &&
        (!needs.sortable || attributeTypes[a.type].sortable),
    )
}

export const attributeOptions = (
  schema: ComposerSchema,
  folderId: string,
  needs: AttributeNeeds = {},
) => attributesFor(schema, folderId, needs).map((a) => ({ value: a.id, label: a.name }))

export const folderOptions = (schema: ComposerSchema) =>
  schema.itemFolders.map((f) => ({ value: f.id, label: f.name }))

/** The folder a binding at `bindingPath` reads, as a string ('' when unset). */
export const folderAt = (form: { get(path: string): unknown }, bindingPath: string) => {
  const v = form.get(`${bindingPath}.folderId`)
  return typeof v === 'string' ? v : ''
}

/** A config value as the text a field shows. */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
