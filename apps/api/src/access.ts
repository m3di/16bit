import { can, type HubRole, type Subject } from '@16bit/core'
import type { Kysely } from 'kysely'
import type { Database } from './db/database.ts'

// Who may see what, decided by `can()` from packages/core (docs/ROLES.md) with the caller's own
// principal row and hub grants. Relations (#47) use it to decide which linked items a caller
// may read; route enforcement (#43) is meant to reuse it.

type Db = Kysely<Database>

/** The principal as `can()` sees it, or null if it is not a principal of the workspace. */
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
