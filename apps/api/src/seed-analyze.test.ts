import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { createItem } from './items.ts'
import { analyzeSeeded } from './seed-analyze.ts'

// #306: after a seed, the planner must know how many items there are. Migration 0017 analyzes
// `item` and `item_index` while they are empty, and that estimate (about none) stood until
// autovacuum came round, so reads right after a seed were planned as nested loops.

let db: Kysely<Database>
let drop: () => Promise<void>

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  await sql`
    ALTER TABLE item SET (autovacuum_enabled = false);
    ALTER TABLE item_index SET (autovacuum_enabled = false);
    INSERT INTO workspace (id, name) VALUES ('w1', 'W');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role)
      VALUES ('w1', 'own', 'user', 'own', 'owner');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
      VALUES ('w1', 'h1', 'h1', NULL, 'h1', 'blue', 'ONE');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, config, indexed)
      VALUES ('w1', 't', 'h1', 'T', 'text', '{}', true);
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
      VALUES ('w1', 'h1', 'h1', 't', 0);
  `.execute(db)
  for (let i = 0; i < 200; i++) {
    await createItem(db, 'w1', 'own', { folderId: 'h1', values: { t: `item ${String(i)}` } })
  }
}, 60_000)

afterAll(async () => {
  await db.destroy()
  await drop()
})

const estimate = async (table: string) => {
  const { rows } = await sql<{ n: number }>`
    SELECT reltuples::int AS n FROM pg_class WHERE oid = ${table}::regclass
  `.execute(db)
  return rows[0]?.n ?? -1
}

it('refreshes the planner statistics of the tables item writes fill', async () => {
  // As migration 0017 left them: analyzed while empty.
  expect(await estimate('item')).toBe(0)
  await analyzeSeeded(db)
  expect(await estimate('item')).toBe(200)
  expect(await estimate('item_index')).toBe(200)
  const { rows } = await sql<{ relname: string }>`
    SELECT relname FROM pg_stat_user_tables
    WHERE relname IN ('item', 'item_index', 'link', 'revision') AND last_analyze IS NOT NULL
    ORDER BY relname
  `.execute(db)
  expect(rows.map((r) => r.relname)).toEqual(['item', 'item_index', 'link', 'revision'])
})
