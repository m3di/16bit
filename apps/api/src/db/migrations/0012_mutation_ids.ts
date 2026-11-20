import { sql, type Kysely } from 'kysely'

// M3 (#169): client mutation IDs on revisions (D59) and the item number order (D61).
//
// - `revision.client_mutation_id`, the UUID a client may send with an item write. Unique per
//   workspace and actor where it is set, so a retry finds the revision its first attempt wrote,
//   and two attempts racing on one ID can't both commit (the loser gets 23505). Writes without
//   one leave it null, and nulls never collide. The API role already inserts into `revision`
//   with a table-level grant (0008), which covers a new column; `revision` stays insert-only.
// - `item_folder_number_idx`, a folder's items by item number, newest first: the `number`
//   order and its offset windows are an index scan on it. `seq_id` is unique per hub (0001),
//   so it orders a folder totally, and the cursor needs no tiebreak.
//
// Both indexes are built inside the migration's transaction, not CONCURRENTLY, so item writes
// wait while `item` is indexed. At M3 sizes that is seconds at most.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE revision ADD COLUMN client_mutation_id uuid;
    CREATE UNIQUE INDEX revision_client_mutation_key
      ON revision (workspace_id, actor, client_mutation_id)
      WHERE client_mutation_id IS NOT NULL;

    CREATE INDEX item_folder_number_idx ON item (workspace_id, folder_id, seq_id DESC);
  `.execute(db)
}

/** Drops the mutation IDs written since. A retry after that applies again (D59 is gone). */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX item_folder_number_idx;
    DROP INDEX revision_client_mutation_key;
    ALTER TABLE revision DROP COLUMN client_mutation_id;
  `.execute(db)
}
