import { sql, type Kysely } from 'kysely'

// Resolves a bearer key's secret hash to its agent principal, workspace and hub
// (docs/ARCHITECTURE.md, "M1 auth"). It runs before the caller has a principal, so under
// row-level security (M1-06) the app role can read neither agent_key nor hub_grant here.
// SECURITY DEFINER runs it with the rights of its owner, the migration role, and it returns
// only what auth needs. Revoked and expired keys return no row, so every failure is one 401.
//
// EXECUTE is revoked from PUBLIC. The app role gets it in M1-06, when it exists; until then
// the API connects as the owner.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION auth_agent_key(p_secret_hash text)
    RETURNS TABLE (workspace_id text, principal_id text, hub_id text, hub_role text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
      SELECT k.workspace_id, k.principal_id, g.hub_id, g.hub_role
      FROM agent_key k
      JOIN hub_grant g ON g.workspace_id = k.workspace_id AND g.principal_id = k.principal_id
      WHERE k.secret_hash = p_secret_hash
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
    $fn$;
    REVOKE ALL ON FUNCTION auth_agent_key(text) FROM PUBLIC;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION auth_agent_key(text)`.execute(db)
}
