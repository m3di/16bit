import { sql, type Transaction } from 'kysely'
import type { Database, HubGrantTable } from './db/database.ts'

/**
 * Appends to `access_log` (D48), taking `seq` from `workspace.next_access_seq`. Call it in the
 * same transaction as the access change; the row lock on the workspace orders concurrent ones.
 */
export async function appendAccessLog(
  trx: Transaction<Database>,
  entry: {
    workspaceId: string
    actor: string
    action: string
    target: string
    detail?: Record<string, unknown>
  },
): Promise<number> {
  const { seq } = await trx
    .updateTable('workspace')
    .set({ next_access_seq: sql`next_access_seq + 1` })
    .where('id', '=', entry.workspaceId)
    .returning(sql<number>`next_access_seq - 1`.as('seq'))
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('access_log')
    .values({
      workspace_id: entry.workspaceId,
      seq,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute()
  return seq
}

/**
 * Seeds only: makes `principalId` hub admin of `hubId`, so the seeded owner can see the hubs a
 * seed creates (D45: owners need a grant too). Logged as a `grant.set` like any other
 * access change, but only when it changed something, so re-running a seed logs nothing.
 */
export async function ensureHubAdmin(
  trx: Transaction<Database>,
  workspaceId: string,
  hubId: string,
  principalId: string,
): Promise<void> {
  const previous = await trx
    .selectFrom('hub_grant')
    .select('hub_role')
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where('principal_id', '=', principalId)
    .forUpdate()
    .executeTakeFirst()
  if (previous?.hub_role === 'hub_admin') return
  await trx
    .insertInto('hub_grant')
    .values({
      workspace_id: workspaceId,
      hub_id: hubId,
      principal_id: principalId,
      hub_role: 'hub_admin',
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'hub_id', 'principal_id']).doUpdateSet({ hub_role: 'hub_admin' }),
    )
    .execute()
  await appendAccessLog(trx, {
    workspaceId,
    actor: principalId,
    action: 'grant.set',
    target: principalId,
    detail: { hubId, hubRole: 'hub_admin', previous: previous?.hub_role ?? null, cause: 'seed' },
  })
}

/**
 * Seeds only: gives a live principal `hubRole` on `hubId` unless it already holds a grant there,
 * logged as a `grant.set` by `actor`. An existing grant, changed through the API or not, is
 * left as it is, and a removed principal gets nothing.
 */
export async function seedHubGrant(
  trx: Transaction<Database>,
  workspaceId: string,
  grant: { hubId: string; principalId: string; hubRole: HubGrantTable['hub_role'] },
  actor: string,
): Promise<boolean> {
  const principal = await trx
    .selectFrom('principal')
    .select('kind')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', grant.principalId)
    .where('removed_at', 'is', null)
    .executeTakeFirst()
  if (!principal) return false
  const inserted = await trx
    .insertInto('hub_grant')
    .values({
      workspace_id: workspaceId,
      hub_id: grant.hubId,
      principal_id: grant.principalId,
      principal_kind: principal.kind,
      hub_role: grant.hubRole,
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'hub_id', 'principal_id']).doNothing())
    .returning('hub_role')
    .executeTakeFirst()
  if (!inserted) return false
  await appendAccessLog(trx, {
    workspaceId,
    actor,
    action: 'grant.set',
    target: grant.principalId,
    detail: { hubId: grant.hubId, hubRole: grant.hubRole, previous: null, cause: 'seed' },
  })
  return true
}
