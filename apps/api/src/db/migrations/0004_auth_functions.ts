import { sql, type Kysely } from 'kysely'

// Two of the three SECURITY DEFINER functions in docs/ARCHITECTURE.md (M1 auth): the lookups
// that run before the caller has a principal in a workspace. Under row-level security (#44)
// the app role can read across workspaces only through these. #42 adds the third (agent keys).
//
// Both are owned by the migration role and pin `search_path`, so a caller can't shadow the
// tables they read. EXECUTE is revoked from PUBLIC; #44 grants it to the app role.
//
// Errors are raised with custom SQLSTATEs the API maps to responses:
//   16B01  invite unknown, used or expired     -> 404
//   16B02  account already in that workspace   -> 409 already_member

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- An account's workspaces and the principal it acts as in each (GET /v1/me, the
    -- workspace list, and resolving a session to a principal for the workspace in the path).
    CREATE FUNCTION account_memberships(p_account_id text)
    RETURNS TABLE (workspace_id text, workspace_name text, principal_id text, workspace_role text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
      SELECT w.id, w.name, p.id, p.workspace_role
      FROM principal p
      JOIN workspace w ON w.id = p.workspace_id
      WHERE p.account_id = p_account_id AND p.kind = 'user'
      ORDER BY w.name, w.id
    $$;
    REVOKE ALL ON FUNCTION account_memberships(text) FROM PUBLIC;

    -- Spends an invite: checks expiry and use, adds the account to the workspace with the
    -- invite's role, marks the invite used, and writes access_log (D48). Returns only the
    -- workspace and the new principal.
    CREATE FUNCTION redeem_invite(p_token_hash text, p_account_id text)
    RETURNS TABLE (workspace_id text, principal_id text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    #variable_conflict use_column
    DECLARE
      inv        invite%ROWTYPE;
      acct_name  text;
      new_id     text := gen_random_uuid()::text;
      log_seq    bigint;
    BEGIN
      SELECT * INTO inv FROM invite i
      WHERE i.token_hash = p_token_hash AND i.used_at IS NULL AND i.expires_at > now()
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invite not found' USING ERRCODE = '16B01';
      END IF;

      SELECT a.name INTO acct_name FROM account a WHERE a.id = p_account_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'account not found' USING ERRCODE = 'no_data_found';
      END IF;

      IF EXISTS (SELECT 1 FROM principal p
                 WHERE p.workspace_id = inv.workspace_id AND p.account_id = p_account_id) THEN
        RAISE EXCEPTION 'already a member' USING ERRCODE = '16B02';
      END IF;

      INSERT INTO principal (workspace_id, id, kind, name, workspace_role, account_id)
      VALUES (inv.workspace_id, new_id, 'user', acct_name, inv.workspace_role, p_account_id);

      UPDATE invite i SET used_at = now()
      WHERE i.workspace_id = inv.workspace_id AND i.id = inv.id;

      UPDATE workspace w SET next_access_seq = w.next_access_seq + 1
      WHERE w.id = inv.workspace_id
      RETURNING w.next_access_seq - 1 INTO log_seq;

      INSERT INTO access_log (workspace_id, seq, actor, action, target, detail)
      VALUES (inv.workspace_id, log_seq, new_id, 'member.join', new_id,
              jsonb_build_object('inviteId', inv.id, 'workspaceRole', inv.workspace_role,
                                 'invitedBy', inv.created_by));

      RETURN QUERY SELECT inv.workspace_id, new_id;
    END
    $$;
    REVOKE ALL ON FUNCTION redeem_invite(text, text) FROM PUBLIC;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION redeem_invite(text, text);
    DROP FUNCTION account_memberships(text);
  `.execute(db)
}
