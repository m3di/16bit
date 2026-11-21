import { sql, type Kysely } from 'kysely'

// M3 (#197, D63): a revision's cause becomes structured: `{ note?, evidence?, causedBy? }`, the
// shape of `itemCauseSchema` in packages/core, with at least one field set.
//
// - `revision.cause` changes from `text` (0001, never written by the API) to `jsonb`. An
//   existing text value becomes `{ "note": <text> }` and an empty one becomes null. A text over
//   500 characters can't be a note, so the migration stops and names how many there are rather
//   than cut them; nothing in this repository ever wrote one.
// - `revision_cause_valid(jsonb)` checks the shape, and the `revision_cause_check` constraint
//   applies it through `revision_cause_ok(jsonb, bigint)`, which adds `causedBy < seq`: a cause
//   names an earlier revision. That the revision
//   exists and that the writer can read it is the API's check (422 `invalid_cause`), made under
//   the writer's row-level security; a constraint can't see through that.
// - The core schema is stricter than the constraint in two ways the database can't follow:
//   `note` is trimmed and counted in UTF-16 units (at most 500, so at most 500 code points), and
//   evidence URLs must parse. The constraint only checks the scheme and the length.
//
// The API role already inserts into `revision` with a table-level grant (0008); `revision`
// stays insert-only. Changing the type rewrites the table inside the migration's transaction, so
// item writes wait for it. At M3 sizes that is seconds at most.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      long_causes bigint;
    BEGIN
      SELECT count(*) INTO long_causes FROM revision WHERE char_length(cause) > 500;
      IF long_causes > 0 THEN
        RAISE EXCEPTION 'revision.cause becomes a note of at most 500 characters (D63); % revisions have a longer one',
          long_causes
          USING HINT = 'Shorten or clear them (UPDATE revision SET cause = ... as the table owner), '
                       'then run the migrations again.';
      END IF;
    END
    $$;

    -- CASE, not AND, wherever a later test would raise on a value of the wrong type: Postgres
    -- does not promise to evaluate AND from left to right.
    CREATE FUNCTION revision_cause_valid(c jsonb) RETURNS boolean
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      RETURN CASE
        WHEN jsonb_typeof(c) IS DISTINCT FROM 'object' THEN false
        WHEN c = '{}'::jsonb OR c - ARRAY['note', 'evidence', 'causedBy'] <> '{}'::jsonb THEN false
        WHEN c ? 'note' AND (jsonb_typeof(c -> 'note') <> 'string'
                             OR char_length(c ->> 'note') NOT BETWEEN 1 AND 500) THEN false
        WHEN c ? 'evidence' AND jsonb_typeof(c -> 'evidence') <> 'array' THEN false
        WHEN c ? 'evidence' AND (
               jsonb_array_length(c -> 'evidence') NOT BETWEEN 1 AND 10
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(c -> 'evidence') e
                 WHERE CASE WHEN jsonb_typeof(e) <> 'string' THEN true
                            ELSE char_length(e #>> '{}') > 2048
                                 OR (e #>> '{}') !~* '^https?:' END)) THEN false
        WHEN c ? 'causedBy' AND jsonb_typeof(c -> 'causedBy') <> 'number' THEN false
        WHEN c ? 'causedBy' AND ((c ->> 'causedBy')::numeric < 1
                                 OR (c ->> 'causedBy')::numeric
                                    <> trunc((c ->> 'causedBy')::numeric)) THEN false
        ELSE true
      END;

    -- A cause names an earlier revision. Read only once revision_cause_valid has passed, so
    -- causedBy is a number here.
    CREATE FUNCTION revision_cause_ok(c jsonb, seq bigint) RETURNS boolean
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      RETURN CASE
        WHEN c IS NULL THEN true
        WHEN NOT revision_cause_valid(c) THEN false
        WHEN c ? 'causedBy' THEN (c ->> 'causedBy')::numeric < seq
        ELSE true
      END;

    ALTER TABLE revision
      ALTER COLUMN cause TYPE jsonb
        USING CASE WHEN cause IS NULL OR cause = '' THEN NULL
                   ELSE jsonb_build_object('note', cause) END,
      ADD CONSTRAINT revision_cause_check CHECK (revision_cause_ok(cause, seq));
  `.execute(db)
}

/** Back to text: each cause as its JSON text, so evidence and `causedBy` are kept, not dropped. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE revision
      DROP CONSTRAINT revision_cause_check,
      ALTER COLUMN cause TYPE text USING cause::text;
    DROP FUNCTION revision_cause_ok(jsonb, bigint);
    DROP FUNCTION revision_cause_valid(jsonb);
  `.execute(db)
}
