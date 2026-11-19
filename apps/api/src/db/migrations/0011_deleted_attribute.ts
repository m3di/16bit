import { sql, type Kysely } from 'kysely'

// A deleted attribute's ID is never reused (#133). Attribute IDs can come from the client, and
// revisions key values by attribute ID: a new attribute taking a deleted one's ID, maybe with
// another type, would make that history read as the new attribute, against D51. Like hub IDs
// (deleted_hub, 0009), the ID is recorded when the attribute is deleted, and an insert with it
// is refused with 23505, which the API answers with 409 id_taken.
//
// - `deleted_attribute`, the tombstones. Attribute IDs are unique per workspace (0001), so the
//   key is (workspace_id, id); hub_id is kept for the record. `deleted_by` is the caller set for
//   the transaction (delete_hub's deletes included), or null when none is (the owner's own
//   deletes, the backfill). Like deleted_hub, RLS on and no grant: the API role can't read it.
// - `attribute_tombstone`, AFTER DELETE: writes the tombstone, so every delete path (the API's
//   attribute delete, delete_hub, the owner) records it without a change to the API.
// - `attribute_id_check`, BEFORE INSERT: refuses a tombstoned ID. Binds every role, like
//   hub_id_check.
// - A backfill: the IDs that revisions carry values for and no attribute has any more. Before
//   this migration only the owner and delete_hub could delete an attribute; history is what a
//   reused ID would corrupt, so that is what the backfill reads.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE deleted_attribute (
      workspace_id  text        NOT NULL REFERENCES workspace (id),
      id            text        NOT NULL,
      hub_id        text        NOT NULL,
      deleted_at    timestamptz NOT NULL DEFAULT now(),
      deleted_by    text,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY (workspace_id, deleted_by) REFERENCES principal (workspace_id, id)
    );
    -- Written only by attribute_tombstone and read only by attribute_id_check, both as the owner.
    ALTER TABLE deleted_attribute ENABLE ROW LEVEL SECURITY;

    -- Definer: the API role has no access to deleted_attribute. The caller only counts in its
    -- own workspace; a delete with no caller set, or another workspace's, records none.
    CREATE FUNCTION attribute_tombstone() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
      INSERT INTO deleted_attribute (workspace_id, id, hub_id, deleted_by)
      VALUES (OLD.workspace_id, OLD.id, OLD.hub_id,
              CASE WHEN rls_workspace() = OLD.workspace_id THEN rls_principal() END)
      ON CONFLICT (workspace_id, id) DO NOTHING;
      RETURN OLD;
    END
    $$;
    CREATE TRIGGER attribute_tombstone AFTER DELETE ON attribute
      FOR EACH ROW EXECUTE FUNCTION attribute_tombstone();

    -- An attribute never takes the ID of a deleted one. Definer: the API role has no access to
    -- deleted_attribute, and may not see an attribute with this ID in a hub it holds no grant
    -- on. That row is locked FOR KEY SHARE first: if a delete of it is in flight, this waits
    -- until that commits, and the next statement, with a new snapshot, sees the tombstone
    -- attribute_tombstone wrote in the same transaction. Without the lock, the insert would pass
    -- this check, wait on the primary key, and succeed once the delete committed.
    CREATE FUNCTION attribute_id_check() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
      PERFORM 1 FROM attribute a
      WHERE a.workspace_id = NEW.workspace_id AND a.id = NEW.id
      FOR KEY SHARE;
      IF EXISTS (SELECT 1 FROM deleted_attribute d
                 WHERE d.workspace_id = NEW.workspace_id AND d.id = NEW.id) THEN
        RAISE EXCEPTION 'a deleted attribute had this ID' USING ERRCODE = '23505';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER attribute_id_check BEFORE INSERT ON attribute
      FOR EACH ROW EXECUTE FUNCTION attribute_id_check();

    REVOKE ALL ON FUNCTION attribute_tombstone() FROM PUBLIC;
    REVOKE ALL ON FUNCTION attribute_id_check() FROM PUBLIC;

    -- Values in revisions for attributes that no longer exist. hub_id is the revision's: an
    -- item stays in its hub, so every revision naming the ID agrees.
    INSERT INTO deleted_attribute (workspace_id, id, hub_id)
    SELECT DISTINCT ON (r.workspace_id, k.id) r.workspace_id, k.id, r.hub_id
    FROM revision r
    CROSS JOIN LATERAL jsonb_object_keys(
      CASE WHEN jsonb_typeof(r.patch -> 'values') = 'object' THEN r.patch -> 'values'
           ELSE '{}'::jsonb END) AS k (id)
    WHERE NOT EXISTS (SELECT 1 FROM attribute a
                      WHERE a.workspace_id = r.workspace_id AND a.id = k.id)
    ORDER BY r.workspace_id, k.id, r.seq;
  `.execute(db)
}

/**
 * Refuses once an attribute has been deleted: dropping deleted_attribute would let a new
 * attribute take that ID and read the old one's history.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM deleted_attribute) THEN
        RAISE EXCEPTION 'attributes have been deleted; their IDs must stay taken';
      END IF;
    END
    $$;
    DROP TRIGGER attribute_id_check ON attribute;
    DROP TRIGGER attribute_tombstone ON attribute;
    DROP FUNCTION attribute_id_check();
    DROP FUNCTION attribute_tombstone();
    DROP TABLE deleted_attribute;
  `.execute(db)
}
