import { sql, type Kysely } from 'kysely'

// M4 (#199, D64): an item may have one external key, a client's own identity for it (a file
// path, a ticket number), unique per hub.
//
// - `item.external_key text NULL`. Null is no key. Adding a nullable column without a default
//   only changes the catalog, so existing items are not rewritten.
// - `item_external_key_check` follows `externalKeySchema` in packages/core: 1 to 200 characters
//   (Postgres counts code points, as core does), no control characters (Unicode `Cc`: U+0001 to
//   U+001F and U+007F to U+009F; text can't hold U+0000), and none of JavaScript's `\s`
//   whitespace at either end. Lone surrogates, which core also refuses, can't be stored in UTF-8.
// - `item_external_key_key`, unique on (workspace_id, hub_id, external_key) where a key is set.
//   Keys compare exactly, byte for byte under the database's deterministic collation. An insert
//   or update that breaks it fails with 23505 naming this index, which the API answers with 409
//   `key_taken`, and two upserts racing on a new key can't both create.
// - The API role may update the column, alongside the others it updates (0008). Reads and
//   inserts are already table-level grants, and row-level security covers the rows.
//
// The index is built inside the migration's transaction, not CONCURRENTLY. Every existing row
// has no key, so the partial index starts empty and building it is a scan of `item`.

const WHITESPACE = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE item
      ADD COLUMN external_key text,
      ADD CONSTRAINT item_external_key_check CHECK (
        char_length(external_key) BETWEEN 1 AND 200
        AND external_key !~ ${sql.lit(String.raw`[\u0001-\u001f\u007f-\u009f]`)}
        AND external_key !~ ${sql.lit(`^${WHITESPACE}`)}
        AND external_key !~ ${sql.lit(`${WHITESPACE}$`)}
      );

    CREATE UNIQUE INDEX item_external_key_key ON item (workspace_id, hub_id, external_key)
      WHERE external_key IS NOT NULL;

    GRANT UPDATE (external_key) ON item TO sixteenbit_app;
  `.execute(db)
}

/**
 * Drops the column, and with it every key written since. Clients that upsert by key would then
 * create new items for keys they had set (D64 is gone).
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    REVOKE UPDATE (external_key) ON item FROM sixteenbit_app;
    DROP INDEX item_external_key_key;
    ALTER TABLE item DROP COLUMN external_key;
  `.execute(db)
}
