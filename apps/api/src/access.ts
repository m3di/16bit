import { can, effectiveHubRole, type HubRole, type Subject } from '@16bit/core'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from './db/database.ts'
import { enforce, notFound } from './http.ts'

// Who may see what, decided by `can()` from packages/core (docs/ROLES.md) with the caller's own
// principal row and hub grants. Relations (#47) use it to decide which linked items a caller
// may read; route enforcement (#43) uses it on every hub, folder and item route.

type Db = Kysely<Database>
type Trx = Transaction<Database>

/**
 * The principal as `can()` sees it, or null if it is not a principal of the workspace.
 * Removed members (#43) are not principals anywhere any more.
 */
export async function loadSubject(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<Subject | null> {
  const row = await db
    .selectFrom('principal')
    .select(['id', 'kind', 'workspace_role'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', principalId)
    .where('removed_at', 'is', null)
    .executeTakeFirst()
  return row ? { id: row.id, kind: row.kind, workspaceRole: row.workspace_role } : null
}

/** The principal's own grants on `hubIds`. Hubs without a grant are absent. */
export async function hubGrants(
  db: Db,
  workspaceId: string,
  principalId: string,
  hubIds: readonly string[],
): Promise<Map<string, HubRole>> {
  if (hubIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('hub_grant')
    .select(['hub_id', 'hub_role'])
    .where('workspace_id', '=', workspaceId)
    .where('principal_id', '=', principalId)
    .where('hub_id', 'in', [...new Set(hubIds)])
    .execute()
  return new Map(rows.map((r) => [r.hub_id, r.hub_role]))
}

/**
 * The hubs among `hubIds` whose items `subject` may read (`hub.read`). Owners and admins need
 * a grant too (D45), so a hub without one is never readable.
 */
export async function readableHubs(
  db: Db,
  workspaceId: string,
  subject: Subject | null,
  hubIds: readonly string[],
): Promise<Set<string>> {
  if (!subject || hubIds.length === 0) return new Set()
  const grants = await hubGrants(db, workspaceId, subject.id, hubIds)
  return new Set(
    hubIds.filter(
      (hubId) => can(subject, 'hub.read', { hubGrant: grants.get(hubId) ?? null }) === 'allow',
    ),
  )
}

/**
 * The principal's own grant on one hub, or null. `lock` holds the row until the transaction
 * ends: `share` so it can't be revoked under a write that relies on it, `update` to change it.
 */
export async function ownGrant(
  db: Db | Trx,
  workspaceId: string,
  hubId: string,
  principalId: string,
  lock?: 'share' | 'update',
): Promise<HubRole | null> {
  let q = db
    .selectFrom('hub_grant')
    .select('hub_role')
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where('principal_id', '=', principalId)
  if (lock === 'share') q = q.forShare()
  if (lock === 'update') q = q.forUpdate()
  const row = await q.executeTakeFirst()
  return row?.hub_role ?? null
}

/**
 * Enforces an action inside a hub for the caller: 404 without a grant (D27, D45), 403 when the
 * grant's role is too low. `what` names the thing a 404 hides, so a hidden hub, folder or item
 * looks the same as a missing one. Returns the caller's effective hub role (docs/ROLES.md).
 */
export async function checkHub(
  db: Db | Trx,
  workspaceId: string,
  principal: Subject,
  hubId: string,
  action: 'hub.read' | 'item.write',
  what: string,
): Promise<HubRole> {
  // A write holds the grant (FOR SHARE) until its transaction ends: call it in the write's
  // transaction, so a revoke waits for the write instead of landing between check and write.
  const lock = action === 'item.write' ? 'share' : undefined
  const hubGrant = await ownGrant(db, workspaceId, hubId, principal.id, lock)
  enforce(can(principal, action, { hubGrant }), what)
  const role = effectiveHubRole(principal, hubGrant)
  // `can()` allows nothing inside a hub without a grant, so this never throws.
  if (role === null) throw notFound(what)
  return role
}

/** The hub of a folder, or 404. A folder's hub never changes, so a check before a write holds. */
export async function folderHub(db: Db, workspaceId: string, folderId: string): Promise<string> {
  const row = await db
    .selectFrom('folder')
    .select('hub_id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', folderId)
    .executeTakeFirst()
  if (!row) throw notFound('Folder')
  return row.hub_id
}

/** The hub of an item, or 404. An item's hub never changes. */
export async function itemHub(db: Db, workspaceId: string, itemId: string): Promise<string> {
  const row = await db
    .selectFrom('item')
    .select('hub_id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', itemId)
    .executeTakeFirst()
  if (!row) throw notFound('Item')
  return row.hub_id
}

/** True if `hubId` is a hub (a folder with no parent) of the workspace. */
export async function hubExists(db: Db | Trx, workspaceId: string, hubId: string) {
  const row = await db
    .selectFrom('folder')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', hubId)
    .where('parent_id', 'is', null)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Every hub in the workspace whose items `subject` may read. Only hubs with a grant can be
 * readable (D45), so this is the principal's grants filtered by `can()`: at most one row per hub.
 */
export async function allReadableHubs(
  db: Db,
  workspaceId: string,
  subject: Subject | null,
): Promise<string[]> {
  if (!subject) return []
  const rows = await db
    .selectFrom('hub_grant')
    .select(['hub_id', 'hub_role'])
    .where('workspace_id', '=', workspaceId)
    .where('principal_id', '=', subject.id)
    .execute()
  return rows
    .filter((r) => can(subject, 'hub.read', { hubGrant: r.hub_role }) === 'allow')
    .map((r) => r.hub_id)
}
