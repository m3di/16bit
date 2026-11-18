import { can, type Invite, type Page, type Subject } from '@16bit/core'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { appendAccessLog } from './access-log.ts'
import type { Database, InviteTable } from './db/database.ts'
import { inTransaction } from './db/scope.ts'
import { decodeCursor, encodeCursor, enforce, HttpError, notFound } from './http.ts'

// Pending invites (#113, D43, D48): owners and admins list them and revoke them. The link stays
// copy-only (D42): the token is shown once at creation and never listed.
//
// A revoke ends the invite the way removing its creator does (members.ts): through `expires_at`,
// the only invite column the API's role may update, and only to end an invite (RLS
// `invite_update`). It is set to `created_at`, not `now()`: `redeem_invite` checks
// `expires_at > now()` with its own transaction's start time, and a redeem that started before
// this transaction but waited for its row lock would still pass a `now()` from here. No redeem
// can start before the invite existed. The revocation time is in `access_log`.

type Db = Kysely<Database>

const toInvite = (
  row: Pick<InviteTable, 'workspace_id' | 'id' | 'workspace_role' | 'created_by'> & {
    created_at: Date
    expires_at: Date
  },
): Invite => ({
  workspaceId: row.workspace_id,
  id: row.id,
  workspaceRole: row.workspace_role,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
})

const inviteCursorSchema = z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)])

/** Pending invites (not used, not expired, not revoked), newest first. */
export async function listInvites(
  db: Db,
  workspaceId: string,
  actor: Subject,
  { limit, cursor }: { limit: number; cursor?: string | undefined },
): Promise<Page<Invite>> {
  enforce(can(actor, 'invite.list'), 'Invite')
  let q = db
    .selectFrom('invite')
    .select(['workspace_id', 'id', 'workspace_role', 'created_by', 'created_at', 'expires_at'])
    // Microsecond text, so the cursor neither skips nor repeats invites made in the same ms.
    .select(
      sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'cursor_at',
      ),
    )
    .where('workspace_id', '=', workspaceId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
  if (cursor) {
    const [at, id] = decodeCursor(inviteCursorSchema, cursor)
    if (Number.isNaN(Date.parse(at))) throw new HttpError('invalid_request', 'Invalid cursor')
    q = q.where(sql<boolean>`(created_at, id) < (${at}::timestamptz, ${id})`)
  }
  const rows = await q
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute()
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items: items.map(toInvite),
    nextCursor: rows.length > limit && last ? encodeCursor([last.cursor_at, last.id]) : null,
  }
}

/**
 * Ends a pending invite, so redeeming it is a 404 like a used one. Revoking an invite that has
 * already ended (used, expired or revoked) changes nothing and logs nothing. An admin can't
 * revoke an owner-role invite (docs/ROLES.md footnote ¹), whatever its state.
 *
 * Lock order (members.ts): the actor's principal FOR SHARE first, then the invite row, then
 * appendAccessLog. Removing the actor locks them, then expires the invites they created; taking
 * the invite before the actor here could deadlock with that. The role is checked again on the
 * locked row, as createHub does, so an actor demoted or removed meanwhile gets 403.
 */
export async function revokeInvite(
  db: Db,
  workspaceId: string,
  actor: Subject,
  inviteId: string,
): Promise<void> {
  // Before any row is read or locked: members, viewers, finance and agents stop here.
  enforce(can(actor, 'invite.list'), 'Invite')
  await inTransaction(db, async (trx) => {
    const self = await trx
      .selectFrom('principal')
      .select('workspace_role')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', actor.id)
      .where('removed_at', 'is', null)
      .forShare()
      .executeTakeFirst()
    if (!self) throw new HttpError('forbidden', 'Your role does not allow this action')
    const locked: Subject = { ...actor, workspaceRole: self.workspace_role }
    enforce(can(locked, 'invite.list'), 'Invite')

    const invite = await trx
      .selectFrom('invite')
      .select([
        'workspace_role',
        sql<boolean>`used_at IS NULL AND expires_at > now()`.as('pending'),
      ])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', inviteId)
      .forUpdate()
      .executeTakeFirst()
    if (!invite) throw notFound('Invite')
    enforce(can(locked, 'invite.revoke', { role: invite.workspace_role }), 'Invite')
    if (!invite.pending) return

    await trx
      .updateTable('invite')
      .set({ expires_at: sql`created_at` })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', inviteId)
      .executeTakeFirstOrThrow()
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'invite.revoke',
      target: inviteId,
      detail: { workspaceRole: invite.workspace_role },
    })
  })
}
