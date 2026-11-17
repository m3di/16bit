import { randomUUID } from 'node:crypto'
import {
  can,
  type HubGrant,
  type HubListEntry,
  type HubRole,
  type Page,
  type PaletteColor,
  type Principal,
  type Subject,
  type WorkspaceRole,
} from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import { hubExists, ownGrant } from './access.ts'
import { appendAccessLog } from './access-log.ts'
import type { Database } from './db/database.ts'
import { inTransaction } from './db/scope.ts'
import { decodeCursor, encodeCursor, enforce, HttpError, notFound } from './http.ts'
import { toFolder } from './mappers.ts'

// Members, hub grants and hub creation (#43, docs/ROLES.md). Every change is an access change,
// written to access_log in the same transaction (D48), never to `revision`.
//
// Lock order, to keep concurrent access changes from deadlocking: principal rows first (owners
// in ID order, then the target), then hub_grant rows.

type Db = Kysely<Database>
type Trx = Transaction<Database>

const nameCursorSchema = z.tuple([z.string(), z.string()])

const toPrincipal = (row: {
  workspace_id: string
  id: string
  kind: 'user' | 'agent'
  name: string
  workspace_role: WorkspaceRole
}): Principal => ({
  workspaceId: row.workspace_id,
  id: row.id,
  kind: row.kind,
  name: row.name,
  workspaceRole: row.workspace_role,
})

const toSubject = (p: Principal): Subject => ({
  id: p.id,
  kind: p.kind,
  workspaceRole: p.workspaceRole,
})

/** The workspace's people, by name. Agents (listed through their keys) and removed members are left out. */
export async function listMembers(
  db: Db,
  workspaceId: string,
  actor: Subject,
  { limit, cursor }: { limit: number; cursor?: string | undefined },
): Promise<Page<Principal>> {
  enforce(can(actor, 'workspace.read'), 'Workspace')
  let q = db
    .selectFrom('principal')
    .select(['workspace_id', 'id', 'kind', 'name', 'workspace_role'])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'user')
    .where('removed_at', 'is', null)
  if (cursor) {
    const [name, id] = decodeCursor(nameCursorSchema, cursor)
    q = q.where(sql<boolean>`(name, id) > (${name}, ${id})`)
  }
  const rows = await q
    .orderBy('name')
    .orderBy('id')
    .limit(limit + 1)
    .execute()
  const items = rows.slice(0, limit).map(toPrincipal)
  const last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor([last.name, last.id]) : null,
  }
}

/**
 * Locks every current owner, then the target, and returns the owner count and the target.
 * With the owners locked, two owners demoting or removing each other run one after the other
 * and the second sees the first's change, so the last owner always stays.
 */
async function lockForMemberChange(trx: Trx, workspaceId: string, targetId: string) {
  const owners = await trx
    .selectFrom('principal')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'user')
    .where('workspace_role', '=', 'owner')
    .where('removed_at', 'is', null)
    .orderBy('id')
    .forUpdate()
    .execute()
  const target = await trx
    .selectFrom('principal')
    .select(['workspace_id', 'id', 'kind', 'name', 'workspace_role', 'account_id'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', targetId)
    .where('removed_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  return { ownerCount: owners.length, target }
}

/**
 * Only owners and admins change or remove members. Checked before any row is read or locked,
 * so nobody else can make the owner rows wait (#71 review). Members are visible to every person
 * in the workspace, so a missing target is a plain 404 once this passes.
 */
export function requireMemberManager(actor: Subject): void {
  const anyMember: Subject = { id: '', kind: 'user', workspaceRole: 'member' }
  enforce(can(actor, 'member.remove', { target: anyMember, ownerCount: 2 }), 'Member')
}

export async function changeMemberRole(
  db: Db,
  workspaceId: string,
  actor: Subject,
  targetId: string,
  role: WorkspaceRole,
): Promise<Principal> {
  requireMemberManager(actor)
  return inTransaction(db, async (trx) => {
    const { ownerCount, target } = await lockForMemberChange(trx, workspaceId, targetId)
    if (!target) throw notFound('Member')
    const current = toPrincipal(target)
    enforce(
      can(actor, 'member.changeRole', { target: toSubject(current), role, ownerCount }),
      'Member',
    )
    if (current.workspaceRole === role) return current

    await trx
      .updateTable('principal')
      .set({ workspace_role: role })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', targetId)
      .execute()
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'member.role',
      target: targetId,
      detail: { from: current.workspaceRole, to: role },
    })
    return { ...current, workspaceRole: role }
  })
}

/**
 * Removes a member by deactivating their principal (#43): their hub grants are revoked, their
 * unused invites expire, `account_id` is cleared so the account can no longer act in this
 * workspace, and `removed_at` is set. The row stays so history keeps its actor. Agent keys they
 * created stay until revoked (docs/ROLES.md).
 */
export async function removeMember(
  db: Db,
  workspaceId: string,
  actor: Subject,
  targetId: string,
): Promise<void> {
  requireMemberManager(actor)
  await inTransaction(db, async (trx) => {
    const { ownerCount, target } = await lockForMemberChange(trx, workspaceId, targetId)
    if (!target) throw notFound('Member')
    enforce(
      can(actor, 'member.remove', { target: toSubject(toPrincipal(target)), ownerCount }),
      'Member',
    )

    const grants = await trx
      .deleteFrom('hub_grant')
      .where('workspace_id', '=', workspaceId)
      .where('principal_id', '=', targetId)
      .returning(['hub_id', 'hub_role'])
      .execute()
    const invites = await trx
      .updateTable('invite')
      .set({ expires_at: sql`now()` })
      .where('workspace_id', '=', workspaceId)
      .where('created_by', '=', targetId)
      .where('used_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning('id')
      .execute()
    await trx
      .updateTable('principal')
      .set({ removed_at: sql`now()`, account_id: null })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', targetId)
      .execute()
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'member.remove',
      target: targetId,
      detail: {
        workspaceRole: target.workspace_role,
        accountId: target.account_id,
        revokedGrants: grants
          .map((g) => ({ hubId: g.hub_id, hubRole: g.hub_role }))
          .sort((a, b) => a.hubId.localeCompare(b.hubId)),
        expiredInvites: invites.map((i) => i.id).sort(),
      },
    })
  })
}

/**
 * The checks shared by setting and revoking a grant. Returns the target, locked against a
 * concurrent removal. A target that is not a member gets 404 only if the actor could manage
 * grants on this hub at all; otherwise 403, so principal IDs can't be probed.
 */
async function grantTarget(
  trx: Trx,
  workspaceId: string,
  actor: Subject,
  hubId: string,
  targetId: string,
): Promise<{ target: Subject; hubGrant: HubRole | null }> {
  const target = await trx
    .selectFrom('principal')
    .select(['id', 'kind', 'workspace_role'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', targetId)
    .where('removed_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (!(await hubExists(trx, workspaceId, hubId))) throw notFound('Hub')
  const hubGrant = await ownGrant(trx, workspaceId, hubId, actor.id, 'share')
  enforce(can(actor, 'hub.see', { hubGrant }), 'Hub')
  if (!target) {
    const anyMember: Subject = { id: '', kind: 'user', workspaceRole: 'member' }
    enforce(can(actor, 'grant.revoke', { hubGrant, target: anyMember }), 'Hub')
    throw notFound('Member')
  }
  return {
    target: { id: target.id, kind: target.kind, workspaceRole: target.workspace_role },
    hubGrant,
  }
}

/** Grants or changes `targetId`'s role on a hub. Self-grants by owners and admins included. */
export async function setHubGrant(
  db: Db,
  workspaceId: string,
  actor: Subject,
  hubId: string,
  targetId: string,
  role: HubRole,
): Promise<HubGrant> {
  return inTransaction(db, async (trx) => {
    const { target, hubGrant } = await grantTarget(trx, workspaceId, actor, hubId, targetId)
    enforce(can(actor, 'grant.set', { hubGrant, target, role }), 'Hub')
    const grant: HubGrant = { workspaceId, hubId, principalId: targetId, hubRole: role }
    const previous = await ownGrant(trx, workspaceId, hubId, targetId, 'update')
    if (previous === role) return grant

    await trx
      .insertInto('hub_grant')
      .values({ workspace_id: workspaceId, hub_id: hubId, principal_id: targetId, hub_role: role })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'hub_id', 'principal_id']).doUpdateSet({ hub_role: role }),
      )
      .execute()
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'grant.set',
      target: targetId,
      detail: { hubId, hubRole: role, previous },
    })
    return grant
  })
}

/** Revokes `targetId`'s grant on a hub. Revoking a grant that doesn't exist changes and logs nothing. */
export async function revokeHubGrant(
  db: Db,
  workspaceId: string,
  actor: Subject,
  hubId: string,
  targetId: string,
): Promise<void> {
  await inTransaction(db, async (trx) => {
    const { target, hubGrant } = await grantTarget(trx, workspaceId, actor, hubId, targetId)
    enforce(can(actor, 'grant.revoke', { hubGrant, target }), 'Hub')
    const removed = await trx
      .deleteFrom('hub_grant')
      .where('workspace_id', '=', workspaceId)
      .where('hub_id', '=', hubId)
      .where('principal_id', '=', targetId)
      .returning('hub_role')
      .executeTakeFirst()
    if (!removed) return
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'grant.revoke',
      target: targetId,
      detail: { hubId, previous: removed.hub_role },
    })
  })
}

/** Creates a hub. The creator becomes its hub admin in the same transaction (docs/ROLES.md). */
export async function createHub(
  db: Db,
  workspaceId: string,
  actor: Subject,
  input: { id?: string | undefined; name: string; color: PaletteColor; idPrefix: string },
): Promise<HubListEntry> {
  enforce(can(actor, 'hub.create'), 'Hub')
  const id = input.id ?? randomUUID()
  return inTransaction(db, async (trx) => {
    const row = await trx
      .insertInto('folder')
      .values({
        workspace_id: workspaceId,
        id,
        hub_id: id,
        parent_id: null,
        name: input.name,
        color: input.color,
        id_prefix: input.idPrefix,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) throw new HttpError('id_taken', 'This folder ID is already used')
    await trx
      .insertInto('hub_grant')
      .values({
        workspace_id: workspaceId,
        hub_id: id,
        principal_id: actor.id,
        hub_role: 'hub_admin',
      })
      .execute()
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'grant.set',
      target: actor.id,
      detail: { hubId: id, hubRole: 'hub_admin', previous: null, cause: 'hub.create' },
    })
    // Only owners and admins create hubs, and their grant is not capped.
    return { ...toFolder(row), access: 'granted', hubRole: 'hub_admin' }
  })
}
