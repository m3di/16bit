import { sql, type Kysely } from 'kysely'

// The third SECURITY DEFINER function in docs/ARCHITECTURE.md (M1 auth), next to the two in
// 0004_auth_functions: resolving a bearer key's secret hash to its agent principal, workspace
// and hub. It runs before the caller has a principal, so under row-level security (#44) the
// app role can read neither agent_key nor hub_grant here. It returns only what auth and
// `GET /v1/me` need, including the workspace and hub names, so the API never reads those
// tables before SET LOCAL. Revoked and expired keys return no row, so every failure is one 401.
//
// Owned by the migration role with `search_path` pinned. EXECUTE is revoked from PUBLIC;
// #44 grants it to the app role.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION auth_agent_key(p_secret_hash text)
    RETURNS TABLE (workspace_id text, workspace_name text, principal_id text,
                   hub_id text, hub_name text, hub_role text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
      SELECT k.workspace_id, w.name, k.principal_id, g.hub_id, h.name, g.hub_role
      FROM agent_key k
      JOIN hub_grant g ON g.workspace_id = k.workspace_id AND g.principal_id = k.principal_id
      JOIN workspace w ON w.id = k.workspace_id
      JOIN folder h ON h.workspace_id = g.workspace_id AND h.id = g.hub_id
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
