import { sql, type Kysely } from 'kysely'

// Removing a member deactivates their principal instead of deleting it (#43): `revision.actor`,
// `access_log.actor`, `invite.created_by` and `agent_key.created_by` reference it with no
// delete behaviour, and history must keep its actor.
//
// A removed principal has `removed_at` set and its `account_id` cleared. Clearing the account
// is what blocks sign-in: `account_memberships` only follows `account_id`, so the account's
// sessions no longer resolve to this workspace, and a later invite can add the account again
// as a new principal (the `(workspace_id, account_id)` key is free). Only people are removed;
// agents are revoked through their keys (D47).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE principal
      ADD COLUMN removed_at timestamptz,
      ADD CONSTRAINT principal_removed_check
        CHECK (removed_at IS NULL OR (kind = 'user' AND account_id IS NULL));
  `.execute(db)
}

/** Refuses while any member is removed: dropping the column would bring them back. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM principal WHERE removed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'principal has removed members; dropping removed_at would restore them';
      END IF;
    END
    $$;
    ALTER TABLE principal
      DROP CONSTRAINT principal_removed_check,
      DROP COLUMN removed_at;
  `.execute(db)
}
