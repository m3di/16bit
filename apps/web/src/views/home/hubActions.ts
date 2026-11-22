import { can, type HubListEntry, type Subject } from '@16bit/core'
import type { RouteLocationRaw } from 'vue-router'
import type { RowAction } from '../../ui/index.ts'
import { SECTION_ROUTES, type HubSettingsSection } from '../hub-settings/sections.ts'
import type { SelfGrant } from './useDashboard.ts'

// The actions menu on a dashboard hub card (issue 234). Every entry follows `can()` in
// `@16bit/core` (docs/ROLES.md), so the menu offers only what the API allows: a viewer sees Open
// and nothing else. Settings entries lead to the settings section that does the work, and Delete
// hub leads to the Danger zone, which checks emptiness and owner grants itself (D52).

export type HubActionKey =
  'open' | 'settings' | 'folders' | 'attributes' | 'access' | 'keys' | 'grant-self' | 'delete'

export interface HubActionEntry extends RowAction {
  key: HubActionKey
}

const allows = (decision: string) => decision === 'allow'

/**
 * The menu's entries for one hub, in menu order. `viewer` is the reader in the hub's workspace
 * (`null` for nobody, which leaves only Open on a hub they hold a grant on). `selfGrant` is a
 * self-grant on its way for this hub, if any.
 */
export function hubActions(
  viewer: Subject | null,
  hub: HubListEntry,
  selfGrant?: SelfGrant,
): HubActionEntry[] {
  if (hub.access === 'none') {
    // Nothing inside the hub exists for the reader until they grant themselves access (D45).
    if (!viewer) return []
    const target = viewer
    if (!allows(can(viewer, 'grant.set', { hubGrant: null, target, role: 'hub_admin' }))) return []
    if (selfGrant?.state === 'stale') return []
    const busy = selfGrant?.state === 'busy'
    return [
      {
        key: 'grant-self',
        label: busy ? 'Giving access' : 'Give myself access',
        ...(busy ? { disabled: true, reason: 'Access is being given.' } : {}),
      },
    ]
  }

  const entries: HubActionEntry[] = [{ key: 'open', label: 'Open' }]
  if (!viewer) return entries
  const hubGrant = hub.hubRole
  if (allows(can(viewer, 'hub.rename', { hubGrant }))) {
    entries.push({ key: 'settings', label: 'Settings' })
  }
  if (allows(can(viewer, 'hub.manageSchema', { hubGrant }))) {
    entries.push({ key: 'folders', label: 'Folders' }, { key: 'attributes', label: 'Attributes' })
  }
  if (allows(can(viewer, 'grant.list', { hubGrant }))) {
    entries.push({ key: 'access', label: 'Access' })
  }
  if (allows(can(viewer, 'key.list', { hubGrant }))) {
    entries.push({ key: 'keys', label: 'Agent keys' })
  }
  // Whether an owner holds a grant is not on the dashboard; the Danger zone reads it and says
  // so when it refuses an admin (D52, docs/ROLES.md footnote 1).
  if (allows(can(viewer, 'hub.delete', { hubGrant, ownerHoldsGrant: false }))) {
    entries.push({ key: 'delete', label: 'Delete hub…', danger: true })
  }
  return entries
}

const SECTION_OF: Partial<Record<HubActionKey, HubSettingsSection>> = {
  settings: 'general',
  folders: 'folders',
  attributes: 'attributes',
  access: 'access',
  keys: 'keys',
  delete: 'danger',
}

/** Where an entry leads, or `null` for one that runs a flow here (the self-grant). */
export function hubActionRoute(key: HubActionKey, hub: HubListEntry): RouteLocationRaw | null {
  const params = { workspaceId: hub.workspaceId, hubId: hub.id }
  if (key === 'open') return { name: 'hub', params }
  const section = SECTION_OF[key]
  return section ? { name: SECTION_ROUTES[section], params } : null
}
