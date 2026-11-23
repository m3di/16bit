import { createPresets, type Filter, type HubDescription, type ItemValues } from '@16bit/core'
import { folderColumns } from '../../hub/useHub.ts'

/**
 * The values "New item" fills in (D77): the group's or column's value and the binding's
 * top-level `AND` equalities, `$me` as the reader. Only attributes the folder shows, which are
 * the ones its form can hold.
 */
export function newItemPresets(
  description: HubDescription | null,
  folderId: string,
  where: Filter | undefined,
  me: string | null,
  group?: { attribute: string; value: string | number | boolean },
): ItemValues {
  if (!description) return {}
  const attributes = folderColumns(description, folderId).map((c) => c.attribute)
  // Without a known reader, a `$me` preset is left out rather than set to someone.
  const values = createPresets(attributes, where, me ?? '', group)
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, v]) => v !== '' && !(Array.isArray(v) && v.length === 1 && v[0] === ''),
    ),
  ) as ItemValues
}
