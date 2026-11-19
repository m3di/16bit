import { sql, type Kysely } from 'kysely'

// docs/ROLES.md footnote 1 for ending an invite (#130): an admin can't end an owner-role invite,
// as `invite_insert` (0008) already keeps an admin from making one. The API refuses first
// (`invite.revoke` in packages/core); this is the floor underneath it.
//
// The rule is in WITH CHECK, not USING. An UPDATE policy's USING also decides which rows a
// caller may lock FOR UPDATE, and revokeInvite locks the invite before it checks the role, so
// USING would turn an admin's 403 into a 404. With WITH CHECK an admin still locks the row, and
// ending it raises 42501. `workspace_role` has no UPDATE grant, so the new row's role is the old.
//
// One exception: an owner-role invite whose creator has been removed. Removing a member expires
// the invites they created (docs/ROLES.md), and an admin may remove an admin who was an owner
// when they invited an owner. removeMember sets `removed_at` before it expires the invites, in
// the same transaction, so the check sees the creator removed. Ending an invite only takes
// access away.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP POLICY invite_update ON invite;
    CREATE POLICY invite_update ON invite FOR UPDATE
      USING (workspace_id = rls_workspace() AND (SELECT rls_admin()))
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_admin())
                  AND expires_at <= now()
                  AND (workspace_role <> 'owner'
                       OR (SELECT rls_workspace_role()) = 'owner'
                       OR EXISTS (SELECT 1 FROM principal p
                                  WHERE p.workspace_id = invite.workspace_id
                                    AND p.id = invite.created_by
                                    AND p.removed_at IS NOT NULL)));
  `.execute(db)
}

/** The policy as 0008 made it. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP POLICY invite_update ON invite;
    CREATE POLICY invite_update ON invite FOR UPDATE
      USING (workspace_id = rls_workspace() AND (SELECT rls_admin()))
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_admin())
                  AND expires_at <= now());
  `.execute(db)
}
