import { can, type HubListEntry, type HubRole, type Subject } from '@16bit/core'
import type { RouteLocationRaw } from 'vue-router'

// Who may open a hub's settings, for the dashboard's gear (issue 240) and the hub page's "Hub
// settings" link: hub admins manage the hub there, and owners and admins also manage its access,
// agent keys and deletion (docs/ROLES.md). A hub the reader holds no grant on has no settings to
// open until they give themselves access (D45).

/** `hubRole` is the reader's grant on the hub, or `null` while it is not known. */
export function opensHubSettings(viewer: Subject | null, hubRole: HubRole | null): boolean {
  if (!viewer) return false
  if (viewer.workspaceRole === 'owner' || viewer.workspaceRole === 'admin') return true
  return hubRole !== null && can(viewer, 'hub.manageSchema', { hubGrant: hubRole }) === 'allow'
}

/** The hub's General settings, or `null` when the reader may not open its settings. */
export function hubSettingsRoute(
  viewer: Subject | null,
  hub: HubListEntry,
): RouteLocationRaw | null {
  if (hub.access !== 'granted' || !opensHubSettings(viewer, hub.hubRole)) return null
  return { name: 'hub-settings-general', params: { workspaceId: hub.workspaceId, hubId: hub.id } }
}
