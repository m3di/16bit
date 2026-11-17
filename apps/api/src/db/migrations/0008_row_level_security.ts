import { sql, type Kysely } from 'kysely'

// Row-level security (#44, docs/ARCHITECTURE.md). The API connects as a member of the group role
// `sixteenbit_app`, which owns nothing and cannot bypass RLS. Every request sets the caller with
// `set_config(..., true)` (SET LOCAL) in its transaction:
//
//   app.workspace_id   the workspace in the path
//   app.principal_id   the caller's principal in it
//
// With either unset, wrong, or naming a principal that is not an active member of the workspace,
// every workspace-scoped table reads as empty and refuses writes. Migrations and seeds run as the
// owner of the tables, which RLS does not apply to (no FORCE). `account` and `session` stay
// outside RLS (D46).
//
// Policies mirror `can()` in packages/core coarsely: workspace isolation, then hub grants with
// the same effective role (viewer and finance act as viewer at most). The API still decides
// every action with `can()`; this is the floor underneath it.
//
// Helpers that read `principal` and `hub_grant` for a policy are SECURITY DEFINER, so a policy
// on hub_grant can ask about hub_grant without recursing. They answer only about the caller in
// the workspace set for the transaction, never about another workspace.
//
// `revision` gains `hub_id`, so its rows can be checked against hub grants even after the item
// is deleted (history outlives items).

const ROLE = 'sixteenbit_app'

/** Workspace-scoped tables. Every one gets RLS. */
const SCOPED = [
  'workspace',
  'principal',
  'invite',
  'agent_key',
  'access_log',
  'folder',
  'attribute',
  'folder_attribute',
  'item',
  'item_index',
  'link',
  'revision',
  'hub_grant',
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Roles are per cluster: another database on the same server may have made it already,
    -- possibly at the same moment (tests migrate several databases in parallel).
    DO $$
    BEGIN
      CREATE ROLE sixteenbit_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END
    $$;

    -- The hub of every revision. Items that still exist give theirs; a deleted item's comes
    -- from the folder its create revision names (folders are never moved between hubs).
    ALTER TABLE revision ADD COLUMN hub_id text;
    UPDATE revision r SET hub_id = i.hub_id
    FROM item i WHERE i.workspace_id = r.workspace_id AND i.id = r.item_id;
    UPDATE revision r SET hub_id = f.hub_id
    FROM revision c
    JOIN folder f ON f.workspace_id = c.workspace_id AND f.id = c.patch ->> 'folderId'
    WHERE r.hub_id IS NULL
      AND c.workspace_id = r.workspace_id AND c.item_id = r.item_id
      AND c.patch ->> 'op' = 'create';
    ALTER TABLE revision
      ALTER COLUMN hub_id SET NOT NULL,
      ADD CONSTRAINT revision_hub_fkey
        FOREIGN KEY (workspace_id, hub_id, hub_id) REFERENCES folder (workspace_id, hub_id, id);

    -- The caller, as set for the transaction. Empty (reset after a transaction) reads as unset.
    CREATE FUNCTION rls_workspace() RETURNS text
    LANGUAGE sql STABLE SET search_path = public, pg_temp
    AS $$ SELECT nullif(current_setting('app.workspace_id', true), '') $$;

    CREATE FUNCTION rls_principal() RETURNS text
    LANGUAGE sql STABLE SET search_path = public, pg_temp
    AS $$ SELECT nullif(current_setting('app.principal_id', true), '') $$;

    -- The caller's workspace role, or null unless they are an active principal of the workspace.
    CREATE FUNCTION rls_workspace_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT p.workspace_role FROM principal p
      WHERE p.workspace_id = rls_workspace() AND p.id = rls_principal() AND p.removed_at IS NULL
    $$;

    CREATE FUNCTION rls_member() RETURNS boolean
    LANGUAGE sql STABLE SET search_path = public, pg_temp
    AS $$ SELECT rls_workspace_role() IS NOT NULL $$;

    -- Owners and admins (agents are always members, D47).
    CREATE FUNCTION rls_admin() RETURNS boolean
    LANGUAGE sql STABLE SET search_path = public, pg_temp
    AS $$ SELECT coalesce(rls_workspace_role() IN ('owner', 'admin'), false) $$;

    -- Hubs where the caller's effective hub role ranks at least p_min:
    -- 1 viewer (read), 2 commenter, 3 editor (write items), 4 hub admin.
    -- Effective as in effectiveHubRole() in packages/core.
    CREATE FUNCTION rls_hubs(p_min int) RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT coalesce(array_agg(g.hub_id), '{}')
      FROM hub_grant g
      JOIN principal p ON p.workspace_id = g.workspace_id AND p.id = g.principal_id
      WHERE g.workspace_id = rls_workspace() AND g.principal_id = rls_principal()
        AND p.removed_at IS NULL
        AND CASE
              WHEN p.workspace_role IN ('viewer', 'finance') THEN 1
              WHEN p.kind = 'agent' AND g.hub_role = 'hub_admin' THEN 3
              ELSE CASE g.hub_role
                     WHEN 'hub_admin' THEN 4 WHEN 'editor' THEN 3
                     WHEN 'commenter' THEN 2 ELSE 1
                   END
            END >= p_min
    $$;

    -- Relation targets for an item write (#47): their hubs, locked FOR KEY SHARE so they can't
    -- be deleted before the links commit. A writer may keep a stored link to an item it cannot
    -- read, so this sees every item of the caller's workspace, but only the ID and hub.
    CREATE FUNCTION lock_link_targets(p_ids text[])
    RETURNS TABLE (id text, hub_id text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT i.id, i.hub_id FROM item i
      WHERE i.workspace_id = rls_workspace() AND rls_member() AND i.id = ANY (p_ids)
      ORDER BY i.id
      FOR KEY SHARE
    $$;

    -- Backlinks' hidden count (#47): links to a readable item from items the caller can't
    -- read, up to p_cap. A count only; their IDs stay hidden. Zero if the item isn't readable.
    CREATE FUNCTION hidden_backlinks(p_item_id text, p_cap int) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT count(*) FROM (
        SELECT 1 FROM link l
        JOIN item t ON t.workspace_id = l.workspace_id AND t.id = l.to_item
        JOIN item s ON s.workspace_id = l.workspace_id AND s.id = l.from_item
        WHERE l.workspace_id = rls_workspace() AND l.to_item = p_item_id
          AND t.hub_id = ANY (rls_hubs(1)) AND NOT (s.hub_id = ANY (rls_hubs(1)))
        LIMIT p_cap
      ) h
    $$;
  `.execute(db)

  // Functions: EXECUTE for the app role only. The two that only read settings are harmless,
  // but one rule for all keeps it simple.
  const functions = [
    'rls_workspace()',
    'rls_principal()',
    'rls_workspace_role()',
    'rls_member()',
    'rls_admin()',
    'rls_hubs(int)',
    'lock_link_targets(text[])',
    'hidden_backlinks(text, int)',
    // The three auth lookups from 0004 and 0005 (docs/ARCHITECTURE.md).
    'auth_agent_key(text)',
    'account_memberships(text)',
    'redeem_invite(text, text)',
  ]
  for (const fn of functions) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`).execute(db)
    await sql.raw(`GRANT EXECUTE ON FUNCTION ${fn} TO ${ROLE}`).execute(db)
  }

  await sql`
    -- Installation-level (D46): no RLS. Accounts are created at invite acceptance; passwords
    -- are reset by the operator's CLI as the owner, so no UPDATE here.
    GRANT SELECT, INSERT ON account TO sixteenbit_app;
    GRANT SELECT, INSERT, DELETE ON session TO sixteenbit_app;
    GRANT UPDATE (last_seen_at) ON session TO sixteenbit_app;

    -- Workspace-scoped. Column grants limit updates to what the API changes; access_log and
    -- revision are append-only.
    GRANT SELECT ON workspace TO sixteenbit_app;
    GRANT UPDATE (next_revision_seq, next_access_seq) ON workspace TO sixteenbit_app;
    GRANT SELECT, INSERT ON principal TO sixteenbit_app;
    GRANT UPDATE (workspace_role, account_id, removed_at) ON principal TO sixteenbit_app;
    GRANT SELECT, INSERT ON invite TO sixteenbit_app;
    GRANT UPDATE (expires_at) ON invite TO sixteenbit_app;
    GRANT SELECT, INSERT ON agent_key TO sixteenbit_app;
    GRANT UPDATE (revoked_at) ON agent_key TO sixteenbit_app;
    GRANT SELECT, INSERT ON access_log TO sixteenbit_app;
    GRANT SELECT, INSERT ON folder TO sixteenbit_app;
    GRANT UPDATE (item_count, next_seq) ON folder TO sixteenbit_app;
    GRANT SELECT ON attribute, folder_attribute TO sixteenbit_app;
    GRANT SELECT, INSERT, DELETE ON item TO sixteenbit_app;
    GRANT UPDATE ("values", version, updated_at, updated_by) ON item TO sixteenbit_app;
    GRANT SELECT, INSERT, DELETE ON item_index, link TO sixteenbit_app;
    GRANT SELECT, INSERT ON revision TO sixteenbit_app;
    GRANT SELECT, INSERT, DELETE ON hub_grant TO sixteenbit_app;
    GRANT UPDATE (hub_role) ON hub_grant TO sixteenbit_app;
  `.execute(db)

  for (const table of SCOPED) {
    await sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).execute(db)
  }

  // Policies are permissive and apply to every role but the owner. Each helper call is wrapped
  // in a scalar subquery so it runs once per statement, not once per row. The `::text[]` cast
  // keeps `= ANY ((SELECT ...))` an array comparison rather than ANY over a subquery.
  await sql`
    CREATE POLICY workspace_read ON workspace FOR SELECT
      USING (id = rls_workspace() AND (SELECT rls_member()));
    CREATE POLICY workspace_update ON workspace FOR UPDATE
      USING (id = rls_workspace() AND (SELECT rls_member()))
      WITH CHECK (id = rls_workspace() AND (SELECT rls_member()));

    -- People see the workspace's principals. The API inserts only agents (people join through
    -- redeem_invite); only owners and admins change roles or remove members. Hub admins lock
    -- a grant's target row (FOR SHARE), which needs the UPDATE policy's USING to pass.
    CREATE POLICY principal_read ON principal FOR SELECT
      USING (workspace_id = rls_workspace() AND (SELECT rls_member()));
    CREATE POLICY principal_insert ON principal FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_member())
                  AND kind = 'agent' AND workspace_role = 'member' AND account_id IS NULL);
    CREATE POLICY principal_update ON principal FOR UPDATE
      USING (workspace_id = rls_workspace() AND (SELECT rls_member()))
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_admin()));

    -- Owners and admins only. Removing a member expires the invites that member created.
    CREATE POLICY invite_read ON invite FOR SELECT
      USING (workspace_id = rls_workspace() AND (SELECT rls_admin()));
    CREATE POLICY invite_insert ON invite FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_admin())
                  AND created_by = rls_principal());
    CREATE POLICY invite_update ON invite FOR UPDATE
      USING (workspace_id = rls_workspace() AND (SELECT rls_admin()))
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_admin()));

    CREATE POLICY agent_key_read ON agent_key FOR SELECT
      USING (workspace_id = rls_workspace() AND (SELECT rls_member()));
    CREATE POLICY agent_key_insert ON agent_key FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_member())
                  AND created_by = rls_principal());
    CREATE POLICY agent_key_update ON agent_key FOR UPDATE
      USING (workspace_id = rls_workspace() AND (SELECT rls_member()))
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_member()));

    CREATE POLICY access_log_read ON access_log FOR SELECT
      USING (workspace_id = rls_workspace() AND (SELECT rls_admin()));
    CREATE POLICY access_log_insert ON access_log FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND (SELECT rls_member())
                  AND actor = rls_principal());

    -- Folders of readable hubs. Owners and admins also see every hub row, for GET /hubs
    -- (names only; the API strips the rest) and for granting on hubs they hold no grant on.
    CREATE POLICY folder_read ON folder FOR SELECT
      USING (workspace_id = rls_workspace()
             AND (hub_id = ANY ((SELECT rls_hubs(1))::text[])
                  OR (parent_id IS NULL AND (SELECT rls_admin()))));
    CREATE POLICY folder_create_hub ON folder FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND parent_id IS NULL AND (SELECT rls_admin()));
    -- Item writes keep the hub's and folder's counters.
    CREATE POLICY folder_update ON folder FOR UPDATE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[]))
      WITH CHECK (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[]));

    CREATE POLICY attribute_read ON attribute FOR SELECT
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]));
    CREATE POLICY folder_attribute_read ON folder_attribute FOR SELECT
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]));

    CREATE POLICY item_read ON item FOR SELECT
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]));
    CREATE POLICY item_insert ON item FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[])
                  AND updated_by = rls_principal());
    -- USING is read access, so a write path can lock a row it then refuses to change; the
    -- change itself needs editor.
    CREATE POLICY item_update ON item FOR UPDATE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]))
      WITH CHECK (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[])
                  AND updated_by = rls_principal());
    CREATE POLICY item_delete ON item FOR DELETE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[]));

    -- item_index and link follow their item: readable with it (link: with its source item),
    -- written with it. The subquery on item is itself filtered by item_read.
    CREATE POLICY item_index_read ON item_index FOR SELECT
      USING (workspace_id = rls_workspace() AND EXISTS (
        SELECT 1 FROM item i WHERE i.workspace_id = item_index.workspace_id
          AND i.id = item_index.item_id));
    CREATE POLICY item_index_insert ON item_index FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND EXISTS (
        SELECT 1 FROM item i WHERE i.workspace_id = item_index.workspace_id
          AND i.id = item_index.item_id AND i.hub_id = ANY ((SELECT rls_hubs(3))::text[])));
    CREATE POLICY item_index_delete ON item_index FOR DELETE
      USING (workspace_id = rls_workspace() AND EXISTS (
        SELECT 1 FROM item i WHERE i.workspace_id = item_index.workspace_id
          AND i.id = item_index.item_id AND i.hub_id = ANY ((SELECT rls_hubs(3))::text[])));

    CREATE POLICY link_read ON link FOR SELECT
      USING (workspace_id = rls_workspace() AND EXISTS (
        SELECT 1 FROM item i WHERE i.workspace_id = link.workspace_id AND i.id = link.from_item));
    CREATE POLICY link_insert ON link FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND EXISTS (
        SELECT 1 FROM item i WHERE i.workspace_id = link.workspace_id AND i.id = link.from_item
          AND i.hub_id = ANY ((SELECT rls_hubs(3))::text[])));
    CREATE POLICY link_delete ON link FOR DELETE
      USING (workspace_id = rls_workspace() AND EXISTS (
        SELECT 1 FROM item i WHERE i.workspace_id = link.workspace_id AND i.id = link.from_item
          AND i.hub_id = ANY ((SELECT rls_hubs(3))::text[])));

    CREATE POLICY revision_read ON revision FOR SELECT
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]));
    CREATE POLICY revision_insert ON revision FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[])
                  AND actor = rls_principal());

    -- A member sees their own grants, the grants on hubs they can read, and owners and admins
    -- see all. Owners, admins and hub admins change them. The caller's own row also passes the
    -- UPDATE policy's USING, so a write can lock the grant it relies on (FOR SHARE); WITH CHECK
    -- still stops anyone raising their own role.
    CREATE POLICY hub_grant_read ON hub_grant FOR SELECT
      USING (workspace_id = rls_workspace() AND (SELECT rls_member())
             AND (principal_id = rls_principal() OR (SELECT rls_admin())
                  OR hub_id = ANY ((SELECT rls_hubs(1))::text[])));
    CREATE POLICY hub_grant_insert ON hub_grant FOR INSERT
      WITH CHECK (workspace_id = rls_workspace()
                  AND ((SELECT rls_admin()) OR hub_id = ANY ((SELECT rls_hubs(4))::text[])));
    CREATE POLICY hub_grant_update ON hub_grant FOR UPDATE
      USING (workspace_id = rls_workspace() AND (SELECT rls_member())
             AND (principal_id = rls_principal() OR (SELECT rls_admin())
                  OR hub_id = ANY ((SELECT rls_hubs(4))::text[])))
      WITH CHECK (workspace_id = rls_workspace()
                  AND ((SELECT rls_admin()) OR hub_id = ANY ((SELECT rls_hubs(4))::text[])));
    CREATE POLICY hub_grant_delete ON hub_grant FOR DELETE
      USING (workspace_id = rls_workspace()
             AND ((SELECT rls_admin()) OR hub_id = ANY ((SELECT rls_hubs(4))::text[])));
  `.execute(db)
}

/** Leaves the `sixteenbit_app` role in place: it belongs to the cluster, not this database. */
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of SCOPED) {
    const { rows } = await sql<{ policyname: string }>`
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}
    `.execute(db)
    for (const { policyname } of rows) {
      await sql`DROP POLICY ${sql.id(policyname)} ON ${sql.table(table)}`.execute(db)
    }
    await sql.raw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`).execute(db)
  }
  await sql
    .raw(
      `REVOKE ALL ON ${[...SCOPED, 'account', 'session'].join(', ')} FROM ${ROLE};
       REVOKE ALL ON FUNCTION auth_agent_key(text), account_memberships(text),
         redeem_invite(text, text) FROM ${ROLE};`,
    )
    .execute(db)
  await sql`
    DROP FUNCTION hidden_backlinks(text, int);
    DROP FUNCTION lock_link_targets(text[]);
    DROP FUNCTION rls_hubs(int);
    DROP FUNCTION rls_admin();
    DROP FUNCTION rls_member();
    DROP FUNCTION rls_workspace_role();
    DROP FUNCTION rls_principal();
    DROP FUNCTION rls_workspace();
    ALTER TABLE revision DROP CONSTRAINT revision_hub_fkey, DROP COLUMN hub_id;
  `.execute(db)
}
