import { sql, type Kysely, type Transaction } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { migrations } from './migrations/index.ts'
import { createTestDatabase } from './test-database.ts'

// Migration 0017 (#299, #193): `item_index.hub_id`, its foreign keys, the hub_id policies and
// PARALLEL SAFE RLS helpers. Row-level security must stay exactly as strict, in serial and in
// parallel plans.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
})

afterEach(async () => {
  await appDb.destroy()
  await db.destroy()
  await drop()
})

const migrator = () =>
  new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

/**
 * w1: hub h1 (folder f1, text attribute a1, items i1 and i3) and hub h2 (a2, item i2), each with
 * index rows. ed1 edits h1, ed2 edits h2, out holds no grant. Inserted as the owner, before or
 * after 0017 (the trigger fills `hub_id` after it).
 */
async function fixtures(): Promise<void> {
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'One');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'Owner', 'owner'), ('w1', 'ed1', 'user', 'Ed 1', 'member'),
      ('w1', 'ed2', 'user', 'Ed 2', 'member'), ('w1', 'out', 'user', 'Out', 'member');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'Hub 1', 'blue', 'A'), ('w1', 'h2', 'h2', NULL, 'Hub 2', 'red', 'B');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
      VALUES ('w1', 'f1', 'h1', 'h1', 'Folder', 'blue', 'A');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, indexed) VALUES
      ('w1', 'a1', 'h1', 'T', 'text', true), ('w1', 'a2', 'h2', 'T', 'text', true);
    INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by) VALUES
      ('w1', 'i1', 'h1', 'f1', 1, '{"a1":"one"}', 'own'),
      ('w1', 'i3', 'h1', 'f1', 2, '{"a1":"three"}', 'own'),
      ('w1', 'i2', 'h2', 'h2', 1, '{"a2":"two"}', 'own');
    INSERT INTO item_index (workspace_id, attribute_id, item_id, txt) VALUES
      ('w1', 'a1', 'i1', 'one'), ('w1', 'a1', 'i3', 'three'), ('w1', 'a2', 'i2', 'two');
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role) VALUES
      ('w1', 'h1', 'own', 'hub_admin'), ('w1', 'h2', 'own', 'hub_admin'),
      ('w1', 'h1', 'ed1', 'editor'), ('w1', 'h2', 'ed2', 'editor');
  `.execute(db)
}

async function as<T>(principalId: string, fn: (trx: Transaction<Database>) => Promise<T>) {
  return appDb.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', 'w1', true),
                     set_config('app.principal_id', ${principalId}, true)`.execute(trx)
    return fn(trx)
  })
}

const code = async (
  principalId: string,
  statement: (trx: Transaction<Database>) => Promise<unknown>,
) => {
  try {
    await as(principalId, statement)
    return 'ok'
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

/** The index rows `who` reads, as `item_id:txt`, in a serial plan or a forced parallel one. */
const visible = (who: string, parallel = false) =>
  as(who, async (trx) => {
    if (parallel) {
      await sql`SELECT set_config('debug_parallel_query', 'on', true)`.execute(trx)
    }
    const { rows } = await sql<{ row: string }>`
      SELECT item_id || ':' || txt AS row FROM item_index ORDER BY 1
    `.execute(trx)
    return rows.map((r) => r.row)
  })

describe('0017_item_index_hub up, down and up again', () => {
  const policies = async () => {
    const { rows } = await sql<{ name: string; qual: string | null; check: string | null }>`
      SELECT policyname AS name, qual, with_check AS check FROM pg_policies
      WHERE tablename = 'item_index' ORDER BY policyname
    `.execute(db)
    return rows
  }
  const parallel = async () => {
    const { rows } = await sql<{ name: string; parallel: string }>`
      SELECT proname AS name, proparallel AS parallel FROM pg_proc
      WHERE proname LIKE 'rls\\_%' ORDER BY proname
    `.execute(db)
    return rows
  }

  it('backfills hub_id from 0016 with data, restores 0016 on down, and applies again', async () => {
    expect((await migrator().migrateTo('0016_views')).error).toBeUndefined()
    await fixtures()
    const policies0016 = await policies()
    const parallel0016 = await parallel()
    expect(parallel0016.every((f) => f.parallel === 'u')).toBe(true)

    expect(await migrateToLatest(db)).toEqual(['0017_item_index_hub', '0018_external_login'])
    const rows = await db
      .selectFrom('item_index')
      .select(['item_id', 'hub_id'])
      .orderBy('item_id')
      .execute()
    expect(rows).toEqual([
      { item_id: 'i1', hub_id: 'h1' },
      { item_id: 'i2', hub_id: 'h2' },
      { item_id: 'i3', hub_id: 'h1' },
    ])
    expect(await policies()).not.toEqual(policies0016)
    const helpers = (await parallel()).filter((f) => f.name !== 'rls_can_change_grant')
    expect(helpers.every((f) => f.parallel === 's')).toBe(true)
    expect(await visible('ed1')).toEqual(['i1:one', 'i3:three'])

    expect((await migrator().migrateTo('0016_views')).error).toBeUndefined()
    expect(await policies()).toEqual(policies0016)
    expect(await parallel()).toEqual(parallel0016)
    expect(await visible('ed1')).toEqual(['i1:one', 'i3:three'])
    expect(await visible('out')).toEqual([])

    expect(await migrateToLatest(db)).toEqual(['0017_item_index_hub', '0018_external_login'])
    expect(await visible('ed2')).toEqual(['i2:two'])
  })
})

describe('0017_item_index_hub on the latest schema', () => {
  beforeEach(async () => {
    await migrateToLatest(db)
    await fixtures()
  })

  it.each([false, true])(
    'shows each reader only its hubs’ rows (parallel plan: %s)',
    async (parallel) => {
      expect(await visible('ed1', parallel)).toEqual(['i1:one', 'i3:three'])
      expect(await visible('ed2', parallel)).toEqual(['i2:two'])
      expect(await visible('out', parallel)).toEqual([])
      expect(await visible('own', parallel)).toEqual(['i1:one', 'i2:two', 'i3:three'])
      // A revoked grant sees nothing at once.
      await sql`DELETE FROM hub_grant WHERE workspace_id = 'w1' AND principal_id = 'ed1'`.execute(
        db,
      )
      expect(await visible('ed1', parallel)).toEqual([])
    },
  )

  it('writes only in the writer’s hubs, with hub_id held to the item’s hub', async () => {
    const insert = (item: string, hub: string, attribute: string) =>
      sql`INSERT INTO item_index (workspace_id, hub_id, attribute_id, item_id, ord, txt)
          VALUES ('w1', ${hub}, ${attribute}, ${item}, 1, 'x')`
    expect(await code('ed1', (trx) => insert('i1', 'h1', 'a1').execute(trx))).toBe('ok')
    // Another hub's item: refused by the policy.
    expect(await code('ed1', (trx) => insert('i2', 'h2', 'a2').execute(trx))).toBe('42501')
    // Another hub's item under the writer's hub: refused by the foreign key.
    expect(await code('ed1', (trx) => insert('i2', 'h1', 'a1').execute(trx))).toBe('23503')
    // Its hub's item with another hub's attribute: refused by the foreign key too.
    expect(await code('own', (trx) => insert('i1', 'h1', 'a2').execute(trx))).toBe('23503')
    // Deleting: own hub only.
    expect(
      await as('ed1', async (trx) =>
        Number(
          (await sql`DELETE FROM item_index WHERE item_id IN ('i1', 'i2')`.execute(trx))
            .numAffectedRows,
        ),
      ),
    ).toBe(2)
    expect(await visible('ed2')).toEqual(['i2:two'])
  })

  it('fills hub_id from the item when a writer leaves it out, and cascades with the item', async () => {
    await sql`INSERT INTO item_index (workspace_id, attribute_id, item_id, ord, txt)
              VALUES ('w1', 'a2', 'i2', 1, 'more')`.execute(db)
    const filled = await db
      .selectFrom('item_index')
      .select('hub_id')
      .where('item_id', '=', 'i2')
      .where('ord', '=', 1)
      .executeTakeFirstOrThrow()
    expect(filled.hub_id).toBe('h2')
    await sql`DELETE FROM item WHERE workspace_id = 'w1' AND id = 'i2'`.execute(db)
    expect(
      await db.selectFrom('item_index').select('item_id').where('item_id', '=', 'i2').execute(),
    ).toEqual([])
  })

  it('reads item_index with exactly item_read’s predicate (change both together, D54)', async () => {
    // item_index_read repeats item_read's predicate instead of following the item. When folder
    // grants (D27, D54) narrow item_read, this fails until item_index_read is changed with it,
    // or a hidden folder's indexed values would stay readable.
    const { rows } = await sql<{ table: string; qual: string }>`
      SELECT tablename AS table, qual FROM pg_policies
      WHERE (tablename, policyname) IN (('item', 'item_read'), ('item_index', 'item_index_read'))
    `.execute(db)
    const qual = (table: string) => rows.find((r) => r.table === table)?.qual
    expect(qual('item')).toBeDefined()
    expect(qual('item_index')).toBe(qual('item'))
  })

  it('lets Postgres plan item_index reads in parallel under row-level security', async () => {
    await sql`
      INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
      SELECT 'w1', 'p' || n, 'h1', 'f1', 10 + n, '{}', 'own' FROM generate_series(1, 5000) n;
      INSERT INTO item_index (workspace_id, hub_id, attribute_id, item_id, txt)
      SELECT 'w1', 'h1', 'a1', 'p' || n, 'v' || n FROM generate_series(1, 5000) n;
      ANALYZE item_index;
    `.execute(db)
    const plan = await as('ed1', async (trx) => {
      await sql`SELECT set_config('parallel_setup_cost', '0', true),
                       set_config('parallel_tuple_cost', '0', true),
                       set_config('min_parallel_table_scan_size', '0', true),
                       set_config('min_parallel_index_scan_size', '0', true)`.execute(trx)
      const { rows } = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN SELECT x.txt, count(*) FROM item_index x GROUP BY x.txt
      `.execute(trx)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
    expect(plan).toMatch(/Workers Planned/)
    expect(plan).not.toMatch(/SubPlan/)
  })
})
