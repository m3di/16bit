import { sql, type Kysely } from 'kysely'

// Faster reads of item_index under row-level security (#299, #193, the #251 spike).
//
// - `item_index.hub_id`, the hub of the row's item (D3), backfilled. A composite foreign key
//   `(workspace_id, hub_id, item_id)` to `item (workspace_id, hub_id, id)` holds it to its item's
//   hub (items never move between hubs; the API role can't update `item.hub_id`), and
//   `(workspace_id, hub_id, attribute_id)` to `attribute` holds the attribute to the same hub.
//   They replace the two-column foreign keys, with the same ON DELETE CASCADE. Writers set it;
//   `item_index_hub_fill` fills it from the item for a writer that leaves it null.
// - The policies check `hub_id` against the caller's hubs, as `item`'s own policies do, instead
//   of an `EXISTS (SELECT ... FROM item ...)` per row. The foreign key makes them exactly as
//   strict: a row's `hub_id` is its item's. The subquery was a SubPlan, which made every
//   statement touching item_index under RLS non-parallel and hashed every readable item of the
//   workspace per reference (#251).
// - The RLS helpers the policies call are PARALLEL SAFE: they only read the caller's settings,
//   `principal` and `hub_grant`, all of which parallel workers see as the leader does (custom
//   settings are copied to workers). Together with the policy, a 50,000-item aggregate can run
//   in parallel under RLS (#251: 650 ms to about 190 ms).
//
// `item` gains UNIQUE (workspace_id, hub_id, id) for the foreign key.

const HELPERS = [
  'rls_workspace()',
  'rls_principal()',
  'rls_workspace_role()',
  'rls_member()',
  'rls_admin()',
  'rls_agent()',
  'rls_rank(text)',
  'rls_hubs(int)',
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE item ADD CONSTRAINT item_hub_item_key UNIQUE (workspace_id, hub_id, id);

    ALTER TABLE item_index ADD COLUMN hub_id text;
    UPDATE item_index x SET hub_id = i.hub_id
    FROM item i WHERE i.workspace_id = x.workspace_id AND i.id = x.item_id;
    ALTER TABLE item_index
      ALTER COLUMN hub_id SET NOT NULL,
      DROP CONSTRAINT item_index_workspace_id_item_id_fkey,
      DROP CONSTRAINT item_index_workspace_id_attribute_id_fkey,
      ADD CONSTRAINT item_index_item_fkey FOREIGN KEY (workspace_id, hub_id, item_id)
        REFERENCES item (workspace_id, hub_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT item_index_attribute_fkey FOREIGN KEY (workspace_id, hub_id, attribute_id)
        REFERENCES attribute (workspace_id, hub_id, id) ON DELETE CASCADE;

    -- For writers that don't set it (scripts, tests). Reads the item as the writer can see it;
    -- a writer under RLS can see the items of the hubs it writes.
    CREATE FUNCTION item_index_hub_fill() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_temp
    AS $$
    BEGIN
      SELECT i.hub_id INTO NEW.hub_id FROM item i
      WHERE i.workspace_id = NEW.workspace_id AND i.id = NEW.item_id;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER item_index_hub_fill BEFORE INSERT ON item_index
      FOR EACH ROW WHEN (NEW.hub_id IS NULL) EXECUTE FUNCTION item_index_hub_fill();

    DROP POLICY item_index_read ON item_index;
    DROP POLICY item_index_insert ON item_index;
    DROP POLICY item_index_delete ON item_index;
    CREATE POLICY item_index_read ON item_index FOR SELECT
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(1))::text[]));
    CREATE POLICY item_index_insert ON item_index FOR INSERT
      WITH CHECK (workspace_id = rls_workspace()
                  AND hub_id = ANY ((SELECT rls_hubs(3))::text[]));
    CREATE POLICY item_index_delete ON item_index FOR DELETE
      USING (workspace_id = rls_workspace() AND hub_id = ANY ((SELECT rls_hubs(3))::text[]));
  `.execute(db)
  await sql.raw(`REVOKE ALL ON FUNCTION item_index_hub_fill() FROM PUBLIC`).execute(db)
  for (const fn of HELPERS) {
    await sql.raw(`ALTER FUNCTION ${fn} PARALLEL SAFE`).execute(db)
  }
}

/** Back to 0008's policies, foreign keys and helpers; the column and its data go. */
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const fn of HELPERS) {
    await sql.raw(`ALTER FUNCTION ${fn} PARALLEL UNSAFE`).execute(db)
  }
  await sql`
    DROP POLICY item_index_read ON item_index;
    DROP POLICY item_index_insert ON item_index;
    DROP POLICY item_index_delete ON item_index;
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

    DROP TRIGGER item_index_hub_fill ON item_index;
    DROP FUNCTION item_index_hub_fill();
    ALTER TABLE item_index
      DROP CONSTRAINT item_index_attribute_fkey,
      DROP CONSTRAINT item_index_item_fkey,
      ADD CONSTRAINT item_index_workspace_id_item_id_fkey FOREIGN KEY (workspace_id, item_id)
        REFERENCES item (workspace_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT item_index_workspace_id_attribute_id_fkey
        FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute (workspace_id, id)
        ON DELETE CASCADE,
      DROP COLUMN hub_id;
    ALTER TABLE item DROP CONSTRAINT item_hub_item_key;
  `.execute(db)
}
