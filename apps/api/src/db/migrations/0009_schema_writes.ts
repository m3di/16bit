import { sql, type Kysely } from 'kysely'

// Schema writes for M2 settings (#111): hub admins manage folders and attributes, owners and
// admins delete empty hubs (D50, D51, D52, docs/ROLES.md).
//
// - `folder.title_attribute_id` names the hub's title attribute (D50). Hub rows only (a CHECK),
//   an attribute of the same hub (composite foreign key), of type `text` (trigger
//   `folder_title_check`), cleared when the attribute is deleted (ON DELETE SET NULL on that
//   column alone).
// - `attribute.version`, so attribute writes check a version like items (D8). Like
//   `folder.version`, it starts at 0. Changes to a folder's attributes (attach, detach, reorder,
//   `required`) check and bump `folder.version`; the API does both in one transaction (#112).
// - The privileges the API role lacked, row-level security for schema writes, and the guard
//   triggers for what a policy can't see (which columns of a folder changed, an attribute's
//   fixed parts, folder cycles).
// - `delete_hub(hub_id)`, the one SECURITY DEFINER function that deletes a hub (D52).
// - `deleted_hub`, the IDs of deleted hubs. The revision history of a deleted hub's items stays
//   (D52), so `revision.hub_id` can no longer reference `folder`; a new hub may never take a
//   deleted hub's ID, or its grant holders would read that history. Hub IDs can come from the
//   client (`POST /hubs` takes an optional `id`).
// - An explicit `GRANT USAGE ON SCHEMA public`: the API role relied on PUBLIC's default, which a
//   hardened or recreated schema doesn't have.
//
// Errors that delete_hub raises, for the API to map:
//   16B03  hub missing, or hidden from the caller            -> 404
//   16B04  hub holds folders or items                        -> 409
//   16B05  a relation attribute in another hub targets it    -> 409
//   42501  role too low, no grant, or an admin while an owner holds a grant -> 403

const ROLE = 'sixteenbit_app'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    GRANT USAGE ON SCHEMA public TO sixteenbit_app;

    ALTER TABLE attribute
      ADD COLUMN version bigint NOT NULL DEFAULT 0 CHECK (version >= 0);

    ALTER TABLE folder
      ADD COLUMN title_attribute_id text,
      ADD CONSTRAINT folder_title_hub_check
        CHECK (title_attribute_id IS NULL OR parent_id IS NULL),
      ADD CONSTRAINT folder_title_attribute_fkey
        FOREIGN KEY (workspace_id, hub_id, title_attribute_id)
        REFERENCES attribute (workspace_id, hub_id, id)
        ON DELETE SET NULL (title_attribute_id);
    -- The SET NULL above looks hub rows up by their title attribute.
    CREATE INDEX folder_title_attribute_idx ON folder (workspace_id, hub_id, title_attribute_id)
      WHERE title_attribute_id IS NOT NULL;

    -- History outlives a deleted hub (D52): its revisions keep hub_id, checked against grants
    -- by revision_read, which no one holds on a deleted hub. deleted_hub replaces the foreign key.
    ALTER TABLE revision DROP CONSTRAINT revision_hub_fkey;

    CREATE TABLE deleted_hub (
      workspace_id  text        NOT NULL REFERENCES workspace (id),
      id            text        NOT NULL,
      deleted_at    timestamptz NOT NULL DEFAULT now(),
      deleted_by    text        NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY (workspace_id, deleted_by) REFERENCES principal (workspace_id, id)
    );
    -- Written only by delete_hub and read only by hub_id_check, both as the owner.
    ALTER TABLE deleted_hub ENABLE ROW LEVEL SECURITY;

    -- Data rules: they hold for every role, migrations and seeds included.

    -- A hub never takes the ID of a deleted one (see deleted_hub). Definer: the API role has no
    -- access to deleted_hub.
    CREATE FUNCTION hub_id_check() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM deleted_hub d
                 WHERE d.workspace_id = NEW.workspace_id AND d.id = NEW.id) THEN
        RAISE EXCEPTION 'a deleted hub had this ID' USING ERRCODE = '23505';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER hub_id_check BEFORE INSERT ON folder
      FOR EACH ROW WHEN (NEW.parent_id IS NULL) EXECUTE FUNCTION hub_id_check();

    -- The title attribute is a text attribute (D50). The foreign key already holds it to the hub.
    CREATE FUNCTION folder_title_check() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NEW.title_attribute_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM attribute a
           WHERE a.workspace_id = NEW.workspace_id AND a.hub_id = NEW.hub_id
             AND a.id = NEW.title_attribute_id AND a.type = 'text') THEN
        RAISE EXCEPTION 'the title attribute must be a text attribute of the hub'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER folder_title_check BEFORE INSERT OR UPDATE OF title_attribute_id ON folder
      FOR EACH ROW EXECUTE FUNCTION folder_title_check();

    -- An attribute named as a title stays text. The API can't change a type at all (D51; no
    -- column grant), so this only binds the owner.
    CREATE FUNCTION attribute_title_type_check() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NEW.type <> 'text' AND EXISTS (
           SELECT 1 FROM folder f
           WHERE f.workspace_id = NEW.workspace_id AND f.hub_id = NEW.hub_id
             AND f.title_attribute_id = NEW.id) THEN
        RAISE EXCEPTION 'a title attribute must stay text' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER attribute_title_type_check BEFORE UPDATE OF type ON attribute
      FOR EACH ROW EXECUTE FUNCTION attribute_title_type_check();

    -- Folders form a tree: a folder never moves under itself or one of its descendants. Moves
    -- in one hub take the hub row first (FOR NO KEY UPDATE, as item writes do when they bump
    -- next_seq), so two concurrent moves can't make a cycle that neither saw.
    CREATE FUNCTION folder_parent_check() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NEW.parent_id IS DISTINCT FROM OLD.parent_id AND NEW.parent_id IS NOT NULL THEN
        PERFORM 1 FROM folder h
        WHERE h.workspace_id = NEW.workspace_id AND h.id = NEW.hub_id
        FOR NO KEY UPDATE;
        IF EXISTS (
             WITH RECURSIVE up (id, parent_id) AS (
               SELECT f.id, f.parent_id FROM folder f
               WHERE f.workspace_id = NEW.workspace_id AND f.id = NEW.parent_id
               UNION
               SELECT f.id, f.parent_id FROM folder f JOIN up ON f.id = up.parent_id
               WHERE f.workspace_id = NEW.workspace_id)
             SELECT 1 FROM up WHERE up.id = NEW.id) THEN
          RAISE EXCEPTION 'a folder cannot move into itself or its own subfolder'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER folder_parent_check BEFORE UPDATE OF parent_id ON folder
      FOR EACH ROW EXECUTE FUNCTION folder_parent_check();

    -- Access rules a policy can't express. Like the guards in 0008, they skip roles RLS does
    -- not apply to.

    -- folder_update lets editors through, for the item counters. Everything else on a folder
    -- (name, colour, parent, title attribute, and the version those changes bump) is the hub
    -- admin's (docs/ROLES.md: rename the hub, manage folders).
    CREATE FUNCTION folder_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NOT row_security_active('folder') THEN RETURN NEW; END IF;
      IF (NEW.name, NEW.color, NEW.parent_id, NEW.title_attribute_id, NEW.version)
           IS DISTINCT FROM
         (OLD.name, OLD.color, OLD.parent_id, OLD.title_attribute_id, OLD.version)
         AND NOT OLD.hub_id = ANY (rls_hubs(4)) THEN
        RAISE EXCEPTION 'only a hub admin changes a folder' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER folder_guard BEFORE UPDATE ON folder
      FOR EACH ROW EXECUTE FUNCTION folder_guard();

    -- A relation's target hub and cross-hub flag are fixed once created (D51). The type and the
    -- hub are fixed by column grants.
    CREATE FUNCTION attribute_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NOT row_security_active('attribute') THEN RETURN NEW; END IF;
      IF OLD.type = 'relation' AND (
           NEW.config -> 'targetHubId' IS DISTINCT FROM OLD.config -> 'targetHubId'
           OR coalesce(NEW.config -> 'crossHub', 'false') IS DISTINCT FROM
              coalesce(OLD.config -> 'crossHub', 'false')) THEN
        RAISE EXCEPTION 'a relation keeps its target hub and cross-hub flag'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER attribute_guard BEFORE UPDATE ON attribute
      FOR EACH ROW EXECUTE FUNCTION attribute_guard();

    -- A new relation's target hub must exist, and is locked FOR KEY SHARE until the attribute
    -- commits, so delete_hub (which takes the hub row FOR UPDATE, then looks for relations
    -- targeting it) either waits for this attribute and sees it, or finishes first and this
    -- insert finds no hub. Definer, because a viewer of the target hub may not lock its row
    -- under folder_update; and so, unlike the guards, it can't tell the owner from the API
    -- role, and holds for both. A config without a target is left to attributeSchema and to
    -- attribute_insert, which refuses it for the API. attribute_insert decides whether the
    -- caller may target the hub.
    CREATE FUNCTION attribute_target_lock() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NOT NEW.config ? 'targetHubId' THEN RETURN NEW; END IF;
      PERFORM 1 FROM folder h
      WHERE h.workspace_id = NEW.workspace_id AND h.id = NEW.config ->> 'targetHubId'
        AND h.parent_id IS NULL
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the relation target hub does not exist' USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER attribute_target_lock BEFORE INSERT ON attribute
      FOR EACH ROW WHEN (NEW.type = 'relation') EXECUTE FUNCTION attribute_target_lock();

    -- Deletes an empty hub (D52, docs/ROLES.md footnote 1) for the caller set for the
    -- transaction. Lock order as for every access change (apps/api/src/members.ts, #92):
    --   1. the caller's principal FOR SHARE (as createHub), so a concurrent removal or
    --      demotion of the caller either waits for this delete or is seen by it;
    --   2. the hub's grants FOR UPDATE, then its agent keys. Item and schema writers hold
    --      their grant FOR SHARE, so they finish first or wait and then find no hub;
    --   3. the hub row FOR UPDATE. Every check reads after it, so a folder, item, grant or
    --      relation attribute added before it is seen, and none can be added after it;
    --   4. the workspace row (next_access_seq), then access_log.
    -- It revokes the hub's agent keys (the rows stay), deletes every grant on the hub, its
    -- folder_attribute rows, then its attributes (D52), then the hub, and records the ID in
    -- deleted_hub. Logged: key.revoke per key it revoked, grant.revoke per grant, hub.delete.
    CREATE FUNCTION delete_hub(p_hub_id text) RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    #variable_conflict use_column
    DECLARE
      v_ws      text := rls_workspace();
      v_actor   text := rls_principal();
      v_role    text;
      v_name    text;
      v_keys    text[];
      v_grants  jsonb;
      v_count   int;
      v_seq     bigint;
    BEGIN
      SELECT p.workspace_role INTO v_role FROM principal p
      WHERE p.workspace_id = v_ws AND p.id = v_actor AND p.removed_at IS NULL
      FOR SHARE;
      IF v_role IS NULL THEN
        RAISE EXCEPTION 'hub not found' USING ERRCODE = '16B03';
      END IF;

      PERFORM 1 FROM hub_grant g
      WHERE g.workspace_id = v_ws AND g.hub_id = p_hub_id
      ORDER BY g.principal_id
      FOR UPDATE;
      PERFORM 1 FROM agent_key k
      JOIN hub_grant g ON g.workspace_id = k.workspace_id AND g.principal_id = k.principal_id
      WHERE k.workspace_id = v_ws AND g.hub_id = p_hub_id
      ORDER BY k.principal_id
      FOR UPDATE OF k;

      SELECT h.name INTO v_name FROM folder h
      WHERE h.workspace_id = v_ws AND h.id = p_hub_id AND h.parent_id IS NULL
      FOR UPDATE;
      -- Hidden as everywhere else: owners and admins see every hub row, others only the hubs
      -- they hold a grant on.
      IF v_name IS NULL OR (v_role NOT IN ('owner', 'admin') AND NOT EXISTS (
           SELECT 1 FROM hub_grant g
           WHERE g.workspace_id = v_ws AND g.hub_id = p_hub_id AND g.principal_id = v_actor)) THEN
        RAISE EXCEPTION 'hub not found' USING ERRCODE = '16B03';
      END IF;
      IF v_role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'only an owner or admin deletes a hub' USING ERRCODE = '42501';
      END IF;
      -- Checking emptiness reads inside the hub, which needs a grant (D45, D52).
      IF NOT EXISTS (SELECT 1 FROM hub_grant g
                     WHERE g.workspace_id = v_ws AND g.hub_id = p_hub_id
                       AND g.principal_id = v_actor) THEN
        RAISE EXCEPTION 'a grant on the hub is needed to delete it' USING ERRCODE = '42501';
      END IF;
      IF v_role = 'admin' AND EXISTS (
           SELECT 1 FROM hub_grant g
           JOIN principal p ON p.workspace_id = g.workspace_id AND p.id = g.principal_id
           WHERE g.workspace_id = v_ws AND g.hub_id = p_hub_id
             AND p.workspace_role = 'owner' AND p.removed_at IS NULL) THEN
        RAISE EXCEPTION 'an admin cannot delete a hub an owner holds a grant on'
          USING ERRCODE = '42501';
      END IF;
      IF EXISTS (SELECT 1 FROM folder f
                 WHERE f.workspace_id = v_ws AND f.hub_id = p_hub_id AND f.id <> p_hub_id)
         OR EXISTS (SELECT 1 FROM item i
                    WHERE i.workspace_id = v_ws AND i.hub_id = p_hub_id) THEN
        RAISE EXCEPTION 'hub is not empty' USING ERRCODE = '16B04';
      END IF;
      IF EXISTS (SELECT 1 FROM attribute a
                 WHERE a.workspace_id = v_ws AND a.hub_id <> p_hub_id AND a.type = 'relation'
                   AND a.config ->> 'targetHubId' = p_hub_id) THEN
        RAISE EXCEPTION 'a relation in another hub targets this hub' USING ERRCODE = '16B05';
      END IF;

      WITH revoked AS (
        UPDATE agent_key k SET revoked_at = now()
        FROM hub_grant g
        WHERE k.workspace_id = v_ws AND k.revoked_at IS NULL
          AND g.workspace_id = k.workspace_id AND g.principal_id = k.principal_id
          AND g.hub_id = p_hub_id
        RETURNING k.principal_id)
      SELECT coalesce(array_agg(principal_id ORDER BY principal_id), '{}') INTO v_keys
      FROM revoked;

      WITH removed AS (
        DELETE FROM hub_grant g
        WHERE g.workspace_id = v_ws AND g.hub_id = p_hub_id
        RETURNING g.principal_id, g.hub_role)
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', principal_id, 'role', hub_role)
                                ORDER BY principal_id), '[]')
      INTO v_grants FROM removed;

      DELETE FROM folder_attribute fa WHERE fa.workspace_id = v_ws AND fa.hub_id = p_hub_id;
      DELETE FROM attribute a WHERE a.workspace_id = v_ws AND a.hub_id = p_hub_id;
      DELETE FROM folder f WHERE f.workspace_id = v_ws AND f.id = p_hub_id;
      INSERT INTO deleted_hub (workspace_id, id, deleted_by) VALUES (v_ws, p_hub_id, v_actor);

      v_count := cardinality(v_keys) + jsonb_array_length(v_grants) + 1;
      UPDATE workspace w SET next_access_seq = w.next_access_seq + v_count
      WHERE w.id = v_ws
      RETURNING w.next_access_seq - v_count INTO v_seq;

      INSERT INTO access_log (workspace_id, seq, actor, action, target, detail)
      SELECT v_ws, v_seq + e.n - 1, v_actor, e.action, e.target, e.detail
      FROM (
        SELECT row_number() OVER (ORDER BY x.part, x.target) AS n, x.action, x.target, x.detail
        FROM (
          SELECT 1 AS part, 'key.revoke' AS action, k AS target,
                 jsonb_build_object('hubId', p_hub_id) AS detail
          FROM unnest(v_keys) k
          UNION ALL
          SELECT 2, 'grant.revoke', g ->> 'id',
                 jsonb_build_object('hubId', p_hub_id, 'previous', g ->> 'role')
          FROM jsonb_array_elements(v_grants) g
          UNION ALL
          SELECT 3, 'hub.delete', p_hub_id, jsonb_build_object('hubId', p_hub_id, 'name', v_name)
        ) x
      ) e;
    END
    $$;
  `.execute(db)

  await sql.raw(`REVOKE ALL ON FUNCTION delete_hub(text) FROM PUBLIC`).execute(db)
  await sql.raw(`GRANT EXECUTE ON FUNCTION delete_hub(text) TO ${ROLE}`).execute(db)
  // Trigger functions are never called directly, but PUBLIC's EXECUTE is the default.
  for (const fn of [
    'hub_id_check()',
    'folder_title_check()',
    'attribute_title_type_check()',
    'folder_parent_check()',
    'folder_guard()',
    'attribute_guard()',
    'attribute_target_lock()',
  ]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`).execute(db)
  }

  await sql`
    -- The API never changes an attribute's type or hub (D51), nor its indexing yet.
    GRANT INSERT, DELETE ON attribute TO sixteenbit_app;
    GRANT UPDATE (name, config, version) ON attribute TO sixteenbit_app;
    GRANT INSERT, DELETE ON folder_attribute TO sixteenbit_app;
    GRANT UPDATE (position, required) ON folder_attribute TO sixteenbit_app;
    GRANT DELETE ON folder TO sixteenbit_app;
    GRANT UPDATE (name, color, parent_id, title_attribute_id, version) ON folder TO sixteenbit_app;
  `.execute(db)

  // Policies: only an effective hub admin writes a hub's schema (rls_hubs(4); viewers, finance
  // and agents never reach it). Folders with a parent are created and deleted here; a hub row is
  // created by folder_create_hub (0008) and deleted only through delete_hub(). A folder with
  // items, subfolders or attributes attached can't be deleted: foreign keys refuse it.
  await sql`
    CREATE POLICY folder_insert ON folder FOR INSERT
      WITH CHECK (workspace_id = rls_workspace() AND parent_id IS NOT NULL
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));
    CREATE POLICY folder_delete ON folder FOR DELETE
      USING (workspace_id = rls_workspace() AND parent_id IS NOT NULL
             AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));

    -- A relation into another hub needs crossHub on and at least viewer access on the target
    -- (D11, docs/ROLES.md); without crossHub it targets its own hub.
    CREATE POLICY attribute_insert ON attribute FOR INSERT
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[])
                  AND (type <> 'relation'
                       OR config ->> 'targetHubId' = hub_id
                       OR (config -> 'crossHub' = 'true'::jsonb
                           AND config ->> 'targetHubId' = ANY ((SELECT rls_hubs(1))::text[]))));
    CREATE POLICY attribute_update ON attribute FOR UPDATE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(4))::text[]))
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));
    CREATE POLICY attribute_delete ON attribute FOR DELETE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));

    CREATE POLICY folder_attribute_insert ON folder_attribute FOR INSERT
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));
    CREATE POLICY folder_attribute_update ON folder_attribute FOR UPDATE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(4))::text[]))
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));
    CREATE POLICY folder_attribute_delete ON folder_attribute FOR DELETE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));
  `.execute(db)
}

/**
 * Refuses once a hub has been deleted: the revision foreign key it restores would not hold, and
 * dropping deleted_hub would let a new hub take that ID. Leaves USAGE on the schema to PUBLIC's
 * default, as before.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM deleted_hub) THEN
        RAISE EXCEPTION 'hubs have been deleted; their history no longer has a hub row';
      END IF;
    END
    $$;
    DROP POLICY folder_attribute_delete ON folder_attribute;
    DROP POLICY folder_attribute_update ON folder_attribute;
    DROP POLICY folder_attribute_insert ON folder_attribute;
    DROP POLICY attribute_delete ON attribute;
    DROP POLICY attribute_update ON attribute;
    DROP POLICY attribute_insert ON attribute;
    DROP POLICY folder_delete ON folder;
    DROP POLICY folder_insert ON folder;

    REVOKE INSERT, UPDATE, DELETE ON attribute, folder_attribute FROM sixteenbit_app;
    REVOKE DELETE ON folder FROM sixteenbit_app;
    REVOKE UPDATE (name, color, parent_id, title_attribute_id, version) ON folder
      FROM sixteenbit_app;

    DROP FUNCTION delete_hub(text);
    DROP TRIGGER attribute_target_lock ON attribute;
    DROP TRIGGER attribute_guard ON attribute;
    DROP TRIGGER folder_guard ON folder;
    DROP TRIGGER folder_parent_check ON folder;
    DROP TRIGGER attribute_title_type_check ON attribute;
    DROP TRIGGER folder_title_check ON folder;
    DROP TRIGGER hub_id_check ON folder;
    DROP FUNCTION attribute_target_lock();
    DROP FUNCTION attribute_guard();
    DROP FUNCTION folder_guard();
    DROP FUNCTION folder_parent_check();
    DROP FUNCTION attribute_title_type_check();
    DROP FUNCTION folder_title_check();
    DROP FUNCTION hub_id_check();

    DROP TABLE deleted_hub;
    ALTER TABLE revision ADD CONSTRAINT revision_hub_fkey
      FOREIGN KEY (workspace_id, hub_id, hub_id) REFERENCES folder (workspace_id, hub_id, id);
    DROP INDEX folder_title_attribute_idx;
    ALTER TABLE folder
      DROP CONSTRAINT folder_title_attribute_fkey,
      DROP CONSTRAINT folder_title_hub_check,
      DROP COLUMN title_attribute_id;
    ALTER TABLE attribute DROP COLUMN version;
    REVOKE USAGE ON SCHEMA public FROM sixteenbit_app;
  `.execute(db)
}
