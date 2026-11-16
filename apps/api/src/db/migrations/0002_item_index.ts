import { sql, type Kysely } from 'kysely'

// item_index (D6): typed copies of the values of attributes marked `indexed`, so filters and
// sorts read typed, indexed columns instead of JSONB. Derived from item.values and written in
// the same transaction as the item (apps/api/src/items.ts).
//
// `ord` numbers the rows of one item and attribute. Single-valued types (all M0 types) write
// one row with ord 0; multi-valued types such as multi-select write one row per value. Sorting
// reads the ord 0 row. An empty value has no row.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE item_index (
      workspace_id  text             NOT NULL,
      attribute_id  text             NOT NULL,
      item_id       text             NOT NULL,
      ord           smallint         NOT NULL DEFAULT 0 CHECK (ord >= 0),
      num           double precision,
      txt           text,
      ts            timestamptz,
      PRIMARY KEY (workspace_id, attribute_id, item_id, ord),
      -- Exactly one typed column per row: the one the attribute type projects to.
      CHECK (num_nonnulls(num, txt, ts) = 1),
      FOREIGN KEY (workspace_id, item_id) REFERENCES item (workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute (workspace_id, id)
        ON DELETE CASCADE
    );
    -- Value lookups for filters. Text is indexed on a prefix: a btree entry is capped at about
    -- 2.7 kB and text values may be up to 10,000 characters. Queries pair left(txt, 256) with
    -- the full comparison.
    CREATE INDEX item_index_num_idx ON item_index (workspace_id, attribute_id, num)
      WHERE num IS NOT NULL;
    CREATE INDEX item_index_txt_idx ON item_index (workspace_id, attribute_id, left(txt, 256))
      WHERE txt IS NOT NULL;
    CREATE INDEX item_index_ts_idx ON item_index (workspace_id, attribute_id, ts)
      WHERE ts IS NOT NULL;
    -- For the cascade from item and for replacing one item's rows.
    CREATE INDEX item_index_item_idx ON item_index (workspace_id, item_id);
  `.execute(db)
  await backfill(db)
}

/**
 * Fills item_index from every item's stored values for indexed attributes. Mirrors `project`
 * of each M0 type in packages/core, in SQL so the migration stays fixed even as core changes.
 * A test compares its output with the write path's. Values of the wrong JSON type are skipped.
 * Like the write path, it indexes only attributes shown on the item's folder.
 */
export async function backfill(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO item_index (workspace_id, attribute_id, item_id, ord, num, txt, ts)
    SELECT i.workspace_id, a.id, i.id, 0,
      CASE
        WHEN a.type = 'number' THEN (v.value #>> '{}')::double precision
        WHEN a.type = 'boolean' THEN CASE WHEN v.value = 'true'::jsonb THEN 1 ELSE 0 END
      END,
      CASE WHEN a.type IN ('text', 'select') THEN v.value #>> '{}' END,
      CASE
        WHEN a.type <> 'date' THEN NULL
        -- A calendar date is UTC midnight, whatever the session time zone.
        WHEN length(v.value #>> '{}') = 10
          THEN ((v.value #>> '{}')::date)::timestamp AT TIME ZONE 'UTC'
        ELSE (v.value #>> '{}')::timestamptz
      END
    FROM item i
    CROSS JOIN LATERAL jsonb_each(i.values) AS v (key, value)
    JOIN attribute a ON a.workspace_id = i.workspace_id AND a.id = v.key
    JOIN folder_attribute fa
      ON fa.workspace_id = i.workspace_id AND fa.folder_id = i.folder_id AND fa.attribute_id = a.id
    WHERE a.indexed
      AND CASE a.type
        WHEN 'number' THEN jsonb_typeof(v.value) = 'number'
        WHEN 'boolean' THEN jsonb_typeof(v.value) = 'boolean'
        WHEN 'text' THEN jsonb_typeof(v.value) = 'string' AND v.value <> '""'::jsonb
        ELSE jsonb_typeof(v.value) = 'string'
      END
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE item_index`.execute(db)
}
