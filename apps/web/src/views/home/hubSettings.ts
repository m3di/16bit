import { can, type HubListEntry, type Subject } from '@16bit/core'
import type { RouteLocationRaw } from 'vue-router'

// The settings link on a dashboard hub card (issue 240). It follows the hub page's "Hub settings"
// link: hub admins manage the hub there, and owners and admins also manage its access, agent
// keys and deletion (docs/ROLES.md). A hub the reader holds no grant on has no settings to open
// until they give themselves access (D45).

/** The hub's General settings, or `null` when the reader may not open its settings. */
export function hubSettingsRoute(
  viewer: Subject | null,
  hub: HubListEntry,
): RouteLocationRaw | null {
  if (!viewer || hub.access !== 'granted') return null
  const manages =
    can(viewer, 'hub.manageSchema', { hubGrant: hub.hubRole }) === 'allow' ||
    viewer.workspaceRole === 'owner' ||
    viewer.workspaceRole === 'admin'
  return manages
    ? { name: 'hub-settings-general', params: { workspaceId: hub.workspaceId, hubId: hub.id } }
    : null
}
