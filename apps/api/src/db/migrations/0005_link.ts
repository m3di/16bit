import { sql, type Kysely } from 'kysely'

// Relations (D7, D11) and the M1 attribute types (D44, #46).
//
// `link` holds one row per item a relation value points to, kept in step with `item.values`
// in the item's write transaction (apps/api/src/items.ts). It is the graph: backlinks read it
// by `to_item`. Deleting either item, or the attribute, removes the row. The value in the
// other item is left as it is; readers treat an ID with no link as an item that is gone.
//
// Whether a target may be linked (it exists, sits in the attribute's target hub, the hub is
// the attribute's own unless `crossHub` is on, and the writer can read it) depends on the
// attribute's JSON config and the writer's grants, so the server checks it, not a constraint.

const M0_TYPES = `'text', 'number', 'boolean', 'date', 'select'`
const M1_TYPES = `'multi_select', 'url', 'actor', 'auto_id', 'rich_text', 'relation'`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attribute DROP CONSTRAINT attribute_type_check;
    ALTER TABLE attribute ADD CONSTRAINT attribute_type_check
      CHECK (type IN (${sql.raw(M0_TYPES)}, ${sql.raw(M1_TYPES)}));

    CREATE TABLE link (
      workspace_id  text NOT NULL REFERENCES workspace (id),
      from_item     text NOT NULL,
      attribute_id  text NOT NULL,
      to_item       text NOT NULL,
      PRIMARY KEY (workspace_id, from_item, attribute_id, to_item),
      FOREIGN KEY (workspace_id, from_item) REFERENCES item (workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, to_item) REFERENCES item (workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute (workspace_id, id)
        ON DELETE CASCADE
    );
    -- Backlinks, paged by (from_item, attribute_id), and the cascade from the target item.
    CREATE INDEX link_to_idx ON link (workspace_id, to_item, from_item, attribute_id);
    -- The cascade from attribute.
    CREATE INDEX link_attribute_idx ON link (workspace_id, attribute_id);
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Fails while any attribute uses an M1 type: those must be removed first, not dropped here.
  await sql`
    DROP TABLE link;
    ALTER TABLE attribute DROP CONSTRAINT attribute_type_check;
    ALTER TABLE attribute ADD CONSTRAINT attribute_type_check CHECK (type IN (${sql.raw(M0_TYPES)}));
  `.execute(db)
}
