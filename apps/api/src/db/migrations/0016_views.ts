import { sql, type Kysely } from 'kysely'

// M4 blocks (#253, D76, D78): root views, views-only folders, and the folder a hub opens on.
//
// - `view`: one root view per folder (the hub root included), unique on (workspace_id,
//   folder_id). `tree` is `{ schemaVersion, root }` as packages/core's `parseViewTree` reads it,
//   at most 128 KiB as Postgres prints it (`viewTreeBytes` in core counts the same way, so a
//   tree core accepts never fails the CHECK). `version` starts at 1; no row means the default
//   view at version 0. The composite foreign key holds the view's hub to its folder's, and
//   cascades, so `delete_hub` (SECURITY DEFINER, 0009) takes the hub root's view with the hub.
// - Row-level security as for `attribute` (D78): read with any grant on the hub, written by an
//   effective hub admin (rls_hubs(4): never viewers, finance or agents), and every insert and
//   update names the caller as `updated_by`. Grants: SELECT, INSERT, DELETE and UPDATE of
//   (tree, version, updated_at, updated_by), never the row's workspace, hub or folder.
// - `folder.views_only` (D76): a folder that holds no items and only shows its view, set at
//   creation (the folder_insert policy covers every column) and fixed after: not in the folder
//   UPDATE grant, and `folder_views_only_fixed` refuses a change for every role. Hub rows are
//   never views-only. `item_views_only_check` refuses an item created in, or moved into, such a
//   folder, for every role, as `hub_id_check` holds D3 underneath the API. It runs AFTER the
//   row passed row-level security, so it never tells a caller about a hub it can't see.
// - `folder_view_check`: a folder with a stored view can't be deleted (D76: reset the view
//   first, so a composed view is never lost in one click). Subfolders only; a hub row goes
//   through delete_hub, which takes its view with it.
// - `folder.opens_on_folder_id` (D76): the folder a hub opens on, or null for the hub root. Built
//   like `title_attribute_id` (0009): hub rows only, never the hub itself (a CHECK; null is
//   the root), a folder of the same hub (the
//   composite foreign key), cleared when that folder is deleted (ON DELETE SET NULL on that
//   column alone), a partial index for that lookup, in the folder UPDATE grant, and in
//   `folder_guard`'s column list, so editors, whom folder_update admits for the item counters,
//   can't change it. folder_guard is replaced here; 0009 stays as merged and `down` restores
//   its body.
//
// Errors the triggers raise, for the API to map:
//   16B07  an item in a views-only folder                    -> 422 views_only
//   16B08  deleting a folder that has a stored view          -> 409 has_view
//
// Findings of the aggregate spike (#251): no index or policy change is needed for D80's budget.

/** folder_guard with `opens_on_folder_id` in its column list. */
const FOLDER_GUARD_0016 = sql`
  CREATE OR REPLACE FUNCTION folder_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NOT row_security_active('folder') THEN RETURN NEW; END IF;
    IF (NEW.name, NEW.color, NEW.parent_id, NEW.title_attribute_id, NEW.opens_on_folder_id,
        NEW.version)
         IS DISTINCT FROM
       (OLD.name, OLD.color, OLD.parent_id, OLD.title_attribute_id, OLD.opens_on_folder_id,
        OLD.version)
       AND NOT OLD.hub_id = ANY (rls_hubs(4)) THEN
      RAISE EXCEPTION 'only a hub admin changes a folder' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
`

/**
 * folder_guard exactly as 0009 created it, whitespace included, so the function after `down` is
 * the one 0009 left (`pg_get_functiondef` compares equal; views-schema.test.ts).
 */
const FOLDER_GUARD_0009 = sql`
    CREATE OR REPLACE FUNCTION folder_guard() RETURNS trigger
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
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE folder
      ADD COLUMN views_only boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT folder_views_only_hub_check CHECK (NOT (views_only AND parent_id IS NULL)),
      ADD COLUMN opens_on_folder_id text,
      ADD CONSTRAINT folder_opens_on_hub_check
        CHECK (opens_on_folder_id IS NULL OR (parent_id IS NULL AND opens_on_folder_id <> id)),
      ADD CONSTRAINT folder_opens_on_folder_fkey
        FOREIGN KEY (workspace_id, hub_id, opens_on_folder_id)
        REFERENCES folder (workspace_id, hub_id, id)
        ON DELETE SET NULL (opens_on_folder_id);
    -- The SET NULL above looks hub rows up by the folder they open on.
    CREATE INDEX folder_opens_on_folder_idx ON folder (workspace_id, hub_id, opens_on_folder_id)
      WHERE opens_on_folder_id IS NOT NULL;

    CREATE TABLE view (
      workspace_id  text        NOT NULL REFERENCES workspace (id),
      id            text        NOT NULL,
      hub_id        text        NOT NULL,
      folder_id     text        NOT NULL,
      tree          jsonb       NOT NULL,
      version       bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    text        NOT NULL,
      PRIMARY KEY (workspace_id, id),
      CONSTRAINT view_folder_key UNIQUE (workspace_id, folder_id),
      CONSTRAINT view_tree_check CHECK (jsonb_typeof(tree) = 'object'),
      CONSTRAINT view_tree_size CHECK (octet_length(tree::text) <= 131072),
      FOREIGN KEY (workspace_id, hub_id, folder_id) REFERENCES folder (workspace_id, hub_id, id)
        ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, updated_by) REFERENCES principal (workspace_id, id)
    );
    -- The cascade from a hub row and the hub's views (view_folder_key covers the folder's).
    CREATE INDEX view_hub_idx ON view (workspace_id, hub_id);

    -- Data rules: they hold for every role, migrations and seeds included.

    CREATE FUNCTION folder_views_only_fixed() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF NEW.views_only IS DISTINCT FROM OLD.views_only THEN
        RAISE EXCEPTION 'a folder is views-only from its creation, or never'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER folder_views_only_fixed BEFORE UPDATE OF views_only ON folder
      FOR EACH ROW EXECUTE FUNCTION folder_views_only_fixed();

    -- views_only never changes, so reading it without a lock is enough. An AFTER trigger, so it
    -- runs only on rows that already passed the item policy's WITH CHECK (and the folder foreign
    -- key, whose trigger sorts first): a caller writing into a hub it can't see gets the
    -- policy's 42501, never 16B07, so this can't probe for hidden views-only folders (as
    -- attribute_target_lock in 0009). Definer, so the folder row is read whatever the caller
    -- sees; by then the caller can write that hub anyway.
    CREATE FUNCTION item_views_only_check() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM folder f
                 WHERE f.workspace_id = NEW.workspace_id AND f.id = NEW.folder_id
                   AND f.views_only) THEN
        RAISE EXCEPTION 'a views-only folder holds no items' USING ERRCODE = '16B07';
      END IF;
      RETURN NULL;
    END
    $$;
    CREATE TRIGGER item_views_only_check AFTER INSERT OR UPDATE OF folder_id ON item
      FOR EACH ROW EXECUTE FUNCTION item_views_only_check();

    -- Runs once the folder row is locked for the delete, so a view inserted before that has
    -- committed or is waiting on the folder (its foreign key takes the row FOR KEY SHARE).
    -- Definer, so the check sees the view whoever deletes.
    CREATE FUNCTION folder_view_check() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM view v
                 WHERE v.workspace_id = OLD.workspace_id AND v.folder_id = OLD.id) THEN
        RAISE EXCEPTION 'reset the folder''s view before deleting it' USING ERRCODE = '16B08';
      END IF;
      RETURN OLD;
    END
    $$;
    CREATE TRIGGER folder_view_check BEFORE DELETE ON folder
      FOR EACH ROW WHEN (OLD.parent_id IS NOT NULL) EXECUTE FUNCTION folder_view_check();
  `.execute(db)

  await FOLDER_GUARD_0016.execute(db)

  for (const fn of [
    'folder_views_only_fixed()',
    'item_views_only_check()',
    'folder_view_check()',
  ]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`).execute(db)
  }

  await sql`
    GRANT UPDATE (opens_on_folder_id) ON folder TO sixteenbit_app;
    GRANT SELECT, INSERT, DELETE ON view TO sixteenbit_app;
    GRANT UPDATE (tree, version, updated_at, updated_by) ON view TO sixteenbit_app;

    ALTER TABLE view ENABLE ROW LEVEL SECURITY;
    -- Policies as attribute's (0008, 0009), plus updated_by on every write (D78).
    CREATE POLICY view_read ON view FOR SELECT
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]));
    CREATE POLICY view_insert ON view FOR INSERT
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[])
                  AND updated_by = rls_principal());
    CREATE POLICY view_update ON view FOR UPDATE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(4))::text[]))
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(4))::text[])
                  AND updated_by = rls_principal());
    CREATE POLICY view_delete ON view FOR DELETE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(4))::text[]));
  `.execute(db)
}

/**
 * Drops every stored view and the two folder columns: views-only folders become ordinary empty
 * folders and hubs open on their root again. Restores folder_guard and the folder UPDATE grant
 * as 0009 left them.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    REVOKE UPDATE (opens_on_folder_id) ON folder FROM sixteenbit_app;
    DROP TABLE view;
    DROP TRIGGER folder_view_check ON folder;
    DROP TRIGGER item_views_only_check ON item;
    DROP TRIGGER folder_views_only_fixed ON folder;
    DROP FUNCTION folder_view_check();
    DROP FUNCTION item_views_only_check();
    DROP FUNCTION folder_views_only_fixed();
  `.execute(db)
  // Before the column goes: the 0016 body names it.
  await FOLDER_GUARD_0009.execute(db)
  await sql`
    DROP INDEX folder_opens_on_folder_idx;
    ALTER TABLE folder
      DROP CONSTRAINT folder_opens_on_folder_fkey,
      DROP CONSTRAINT folder_opens_on_hub_check,
      DROP COLUMN opens_on_folder_id,
      DROP CONSTRAINT folder_views_only_hub_check,
      DROP COLUMN views_only;
  `.execute(db)
}
