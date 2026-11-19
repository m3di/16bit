import { can, type Me, type Subject } from '@16bit/core'
import { viewerOf } from '../hub-settings/access.ts'

/**
 * The reader as the subject of a self-grant in this workspace, or `null` when they may not
 * give themselves access. Decided by `can('grant.set')` (docs/ROLES.md, D45): the reader holds
 * no grant on a "no access" hub, and asks for hub admin on their own row.
 */
export function selfGranter(me: Me | null, workspaceId: string): Subject | null {
  const viewer = viewerOf(me, workspaceId)
  if (!viewer) return null
  const decision = can(viewer, 'grant.set', { hubGrant: null, target: viewer, role: 'hub_admin' })
  return decision === 'allow' ? viewer : null
}
