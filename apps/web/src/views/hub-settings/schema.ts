import {
  can,
  createAttributeSchema,
  type Attribute,
  type AttributeTypeName,
  type CreateAttribute,
  type Folder,
  type HubDescription,
  type HubRole,
  type Me,
  type PaletteColor,
  type SelectOption,
} from '@16bit/core'
import { ATTRIBUTE_TYPE_INFO, optionErrors } from '../../ui/index.ts'
import { folderTree, type FolderEntry } from '../hub/useHub.ts'

// Pure rules for hub settings, folders and attributes: who may change them, what a folder may
// move under, what blocks a delete, and the create body for each attribute type.

export {
  SECTION_LABELS,
  SECTION_PATHS,
  SECTION_ROUTES,
  type HubSettingsSection,
} from './sections.ts'

/** Shown wherever a reader without `hub.manageSchema` sees the schema read-only. */
export const READ_ONLY_REASON = 'Only hub admins can change folders and attributes.'

/**
 * Whether the reader may change folders and attributes (`hub.manageSchema`). The hub role
 * from the hub description is already capped by the workspace role, so it stands in for the
 * grant: a capped role is never `hub_admin`.
 */
export function canManageSchema(me: Me | null, workspaceId: string, hubRole: HubRole): boolean {
  if (!me || me.kind !== 'person') return false
  const membership = me.memberships.find((m) => m.workspace.id === workspaceId)
  if (!membership) return false
  const subject = { id: membership.principalId, kind: 'user' as const, ...membership }
  return can(subject, 'hub.manageSchema', { hubGrant: hubRole }) === 'allow'
}

/** The hub and its folders in tree order, with the hub first at depth 0 and folders under it. */
export function settingsTree(description: HubDescription): FolderEntry[] {
  // folderTree puts the hub and its direct children both at depth 0; settings indents children.
  return folderTree(description).map((entry) =>
    entry.folder.id === description.hub.id ? entry : { ...entry, depth: entry.depth + 1 },
  )
}

/** IDs of a folder and every folder under it. */
export function descendantIds(description: HubDescription, folderId: string): Set<string> {
  const out = new Set([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of description.folders) {
      if (f.parentId !== null && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
    }
  }
  return out
}

/**
 * Where a folder may sit: the hub or any folder, but not the folder itself or one under it
 * (the API refuses a cycle with a 400). `folderId` null is a new folder: anywhere.
 */
export function parentChoices(
  description: HubDescription,
  folderId: string | null,
): { value: string; label: string }[] {
  const blocked = folderId ? descendantIds(description, folderId) : new Set<string>()
  return settingsTree(description)
    .filter((entry) => !blocked.has(entry.folder.id))
    .map((entry) => ({
      value: entry.folder.id,
      // Native options cannot be styled, so depth is shown with leading dashes.
      label: `${'– '.repeat(entry.depth)}${entry.folder.name}`,
    }))
}

/** Why a folder cannot be deleted yet, or `''`. The server checks again (409 `not_empty`). */
export function deleteBlockedReason(description: HubDescription, folder: Folder): string {
  if (folder.id === description.hub.id) return 'The hub is deleted from its danger zone.'
  const children = description.folders.filter((f) => f.parentId === folder.id).length
  if (folder.itemCount > 0 && children > 0) return 'It still holds items and folders.'
  if (folder.itemCount > 0) return 'It still holds items.'
  if (children > 0) return 'It still holds folders.'
  return ''
}

/** Names of the folders (and the hub) that show an attribute, in tree order. */
export function usedIn(description: HubDescription, attributeId: string): string[] {
  const shown = new Set(
    description.folderAttributes
      .filter((fa) => fa.attributeId === attributeId)
      .map((fa) => fa.folderId),
  )
  return settingsTree(description)
    .filter((entry) => shown.has(entry.folder.id))
    .map((entry) => entry.folder.name)
}

/** How many attributes a folder shows. */
export const attributeCount = (description: HubDescription, folderId: string): number =>
  description.folderAttributes.filter((fa) => fa.folderId === folderId).length

export const typeLabel = (type: AttributeTypeName): string => ATTRIBUTE_TYPE_INFO[type].label

const formatCount = (n: number) => new Intl.NumberFormat('en').format(n)

/** "1 item", "1,280 items". */
export const items = (n: number) => (n === 1 ? '1 item' : `${formatCount(n)} items`)

/** The confirm text for a write that strips values (D51), from the server's `affected`. */
export function strippedValuesMessage(
  what: 'options' | 'attribute',
  name: string,
  affected: number,
): string {
  const holds = affected === 1 ? '1 item holds' : `${formatCount(affected)} items hold`
  if (what === 'options') {
    return `${holds} an option you removed from ${name}. Saving clears that value on ${affected === 1 ? 'it' : 'them'}, with a revision each.`
  }
  return `${holds} a value for ${name}. Deleting it clears ${affected === 1 ? 'that value' : 'those values'}, with a revision each, and removes it from every folder.`
}

/** "Points: 12 items in Backlog leave it empty." for a required attribute (D51). */
export function requiredEmptyText(attributeName: string, folderName: string, count: number) {
  const leave = count === 1 ? '1 item in' : `${formatCount(count)} items in`
  return `${attributeName}: ${leave} ${folderName} ${count === 1 ? 'leaves' : 'leave'} it empty.`
}

// ----------------------------------------------------------------------------------------
// New attribute

export type NumberFormat = 'plain' | 'percent' | 'currency'

/** The new-attribute form. Fields that do not apply to the chosen type are ignored. */
export interface AttributeDraft {
  name: string
  type: AttributeTypeName | null
  indexed: boolean
  /** select and multi_select. */
  options: SelectOption[]
  /** actor and relation: more than one value. */
  multiple: boolean
  /** date. */
  includeTime: boolean
  /** number. */
  numberFormat: NumberFormat
  currency: string
  /** auto_id, optional. */
  prefix: string
  /** relation: this hub or another one the reader can see. */
  targetHubId: string
}

export function emptyDraft(hubId: string): AttributeDraft {
  return {
    name: '',
    type: null,
    indexed: false,
    options: [],
    multiple: false,
    includeTime: false,
    numberFormat: 'plain',
    currency: '',
    prefix: '',
    targetHubId: hubId,
  }
}

export type DraftField = 'name' | 'type' | 'options' | 'currency' | 'prefix' | 'targetHubId'

export type DraftResult =
  { ok: true; body: CreateAttribute } | { ok: false; errors: Partial<Record<DraftField, string>> }

function configFor(draft: AttributeDraft, hubId: string): Record<string, unknown> {
  switch (draft.type) {
    case 'number':
      return draft.numberFormat === 'currency'
        ? { format: 'currency', currency: draft.currency.trim().toUpperCase() }
        : { format: draft.numberFormat }
    case 'date':
      return { includeTime: draft.includeTime }
    case 'select':
    case 'multi_select':
      return {
        options: draft.options.map((o) => ({ ...o, label: o.label.trim() })),
      }
    case 'actor':
      return { multiple: draft.multiple }
    case 'auto_id': {
      const prefix = draft.prefix.trim().toUpperCase()
      return prefix ? { prefix } : {}
    }
    case 'relation':
      return {
        targetHubId: draft.targetHubId,
        crossHub: draft.targetHubId !== hubId,
        multiple: draft.multiple,
      }
    default:
      return {}
  }
}

/** Checks the form and builds `POST /hubs/:hubId/attributes`, or says what to fix. */
export function buildCreateAttribute(draft: AttributeDraft, hubId: string): DraftResult {
  const errors: Partial<Record<DraftField, string>> = {}
  if (!draft.name.trim()) errors.name = 'Name the attribute.'
  if (!draft.type) errors.type = 'Choose a type.'
  if (draft.type === 'select' || draft.type === 'multi_select') {
    if (Object.keys(optionErrors(draft.options)).length > 0) {
      errors.options = 'Fix the options marked above.'
    }
  }
  if (
    draft.type === 'number' &&
    draft.numberFormat === 'currency' &&
    !/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())
  ) {
    errors.currency = 'Use a three-letter currency code, such as EUR.'
  }
  if (draft.type === 'auto_id' && draft.prefix.trim()) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(draft.prefix.trim().toUpperCase())) {
      errors.prefix = 'A letter, then up to 9 letters or digits.'
    }
  }
  if (draft.type === 'relation' && !draft.targetHubId) errors.targetHubId = 'Choose a hub.'
  if (Object.keys(errors).length > 0 || !draft.type) return { ok: false, errors }

  const parsed = createAttributeSchema.safeParse({
    name: draft.name.trim(),
    type: draft.type,
    indexed: draft.indexed,
    config: configFor(draft, hubId),
  })
  if (!parsed.success) {
    return { ok: false, errors: { name: parsed.error.issues[0]?.message ?? 'Check the form.' } }
  }
  return { ok: true, body: parsed.data as CreateAttribute }
}

/** What an attribute's config says, for the edit form where it can no longer change (D51). */
export function configSummary(attribute: Attribute, hubName: (id: string) => string): string {
  switch (attribute.type) {
    case 'number':
      return attribute.config.format === 'currency'
        ? `Currency, ${attribute.config.currency ?? ''}`.trim()
        : attribute.config.format === 'percent'
          ? 'Percent'
          : 'Plain number'
    case 'date':
      return attribute.config.includeTime ? 'Date and time' : 'Date only'
    case 'actor':
      return attribute.config.multiple ? 'Several people or agents' : 'One person or agent'
    case 'auto_id':
      return attribute.config.prefix ? `Prefix ${attribute.config.prefix}` : 'No prefix'
    case 'relation': {
      const many = attribute.config.multiple ? 'several items' : 'one item'
      return `Links to ${many} in ${hubName(attribute.config.targetHubId)}`
    }
    default:
      return ''
  }
}

/** Colour of a new folder: the next palette colour after those in use, so siblings differ. */
export function nextFolderColor(description: HubDescription, palette: readonly PaletteColor[]) {
  const used = new Set([description.hub.color, ...description.folders.map((f) => f.color)])
  return palette.find((c) => !used.has(c)) ?? palette[0] ?? 'indigo'
}
