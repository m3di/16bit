import { sql, type Kysely } from 'kysely'

// M3 (#177, D56): a hub's ID prefix is unique in its workspace, so a mono ID such as `ENG-12`
// names one item.
//
// - `folder_hub_prefix_key`, unique on (workspace_id, id_prefix) for hub rows only. Subfolders
//   carry their hub's prefix (item numbers are per hub), so they are left out. A deleted hub's
//   row is gone, so its prefix is free again. An insert that breaks it fails with 23505 naming
//   this index, which `POST /hubs` answers with 409 `prefix_taken`.
// - Before building it, the migration looks for hubs that already share a prefix and stops with
//   a message naming them (at most 20 prefixes, then a count). Nothing is renamed for you: a
//   prefix is permanent and shows in every item ID, so the operator chooses which hub changes,
//   with `UPDATE folder SET id_prefix = ... WHERE workspace_id = ... AND hub_id = ...`, which
//   moves the hub and its subfolders together.
//
// The index is built inside the migration's transaction, not CONCURRENTLY. Hub rows are few.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      groups  text[];
      total   int;
    BEGIN
      SELECT array_agg(format('workspace %s, prefix %s: hubs %s', workspace_id, id_prefix, hubs)
                       ORDER BY workspace_id, id_prefix),
             count(*)
        INTO groups, total
      FROM (
        SELECT workspace_id, id_prefix, string_agg(id, ', ' ORDER BY id) AS hubs
        FROM folder
        WHERE parent_id IS NULL
        GROUP BY workspace_id, id_prefix
        HAVING count(*) > 1
      ) d;
      IF total > 0 THEN
        RAISE EXCEPTION 'hub ID prefixes must be unique in a workspace (D56); % shared: %',
          total, array_to_string(groups[1:20], '; ')
            || CASE WHEN total > 20 THEN format('; and %s more', total - 20) ELSE '' END
          USING HINT = 'Give all but one hub of each a new prefix, on the hub row and its '
                       'subfolders (same hub_id), then run the migrations again.';
      END IF;
    END
    $$;

    CREATE UNIQUE INDEX folder_hub_prefix_key ON folder (workspace_id, id_prefix)
      WHERE parent_id IS NULL;
  `.execute(db)
}

/** Lets two hubs share a prefix again. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX folder_hub_prefix_key`.execute(db)
}
