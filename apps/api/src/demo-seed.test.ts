import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { hubPageSchema, validateItemValues, workspacePageSchema, type Folder } from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { applySeed, demoSeed } from './demo-seed.ts'
import { folderDefinitions } from './items.ts'

// Integration tests: the demo seed against a fresh, migrated Postgres database. The seed is
// applied once in beforeAll; the later tests run it again, so they depend on test order.

const KEY = 'test-key'
const ACTOR = 'dev-owner'
const auth = { authorization: `Bearer ${KEY}` }

let db: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  await applySeed(db, { devPrincipalId: ACTOR })
  app = buildApp({ db, devApiKey: KEY, devPrincipalId: ACTOR })
}, 120_000)

afterAll(async () => {
  await app.close()
  await db.destroy()
  await drop()
})

/** The SizeMeter steps in docs/DESIGN.md: 0, 1 to 9, under 100, under 1,000, 1,000 or more. */
const sizeStep = (count: number): number =>
  count === 0 ? 0 : count < 10 ? 1 : count < 100 ? 2 : count < 1000 ? 3 : 4

async function hubs(workspaceId: string): Promise<Folder[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}/hubs?limit=50`,
    headers: auth,
  })
  expect(res.statusCode).toBe(200)
  // The seed makes the dev owner hub admin of every hub it creates (D45).
  return hubPageSchema.parse(res.json()).items.map((h) => {
    if (h.access !== 'granted' || h.hubRole !== 'hub_admin') throw new Error(`No grant on ${h.id}`)
    return h
  })
}

/** Row counts per table, to prove a second run writes nothing. */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = [
    'workspace',
    'principal',
    'folder',
    'attribute',
    'folder_attribute',
    'item',
    'revision',
    'hub_grant',
    'access_log',
  ] as const
  const counts: Record<string, number> = {}
  for (const table of tables) {
    const { n } = await db
      .selectFrom(table)
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow()
    counts[table] = n
  }
  return counts
}

describe('demo seed', () => {
  it('creates two workspaces the dev key can see', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: auth })
    expect(res.statusCode).toBe(200)
    const ids = workspacePageSchema.parse(res.json()).items.map((w) => w.id)
    expect(ids.sort()).toEqual(['acme', 'demo'])
  })

  it('has hubs at every size-meter step, with nested folders', async () => {
    const all = [...(await hubs('demo')), ...(await hubs('acme'))]
    expect(new Set(all.map((h) => sizeStep(h.itemCount)))).toEqual(new Set([0, 1, 2, 3, 4]))
    // The first workspace alone shows every step, so one dashboard screen covers the meter.
    const demo = await hubs('demo')
    expect(new Set(demo.map((h) => sizeStep(h.itemCount)))).toEqual(new Set([0, 1, 2, 3, 4]))

    const nested = await db
      .selectFrom('folder as child')
      .innerJoin('folder as parent', (j) =>
        j
          .onRef('parent.workspace_id', '=', 'child.workspace_id')
          .onRef('parent.id', '=', 'child.parent_id'),
      )
      .select('child.id')
      .where('child.workspace_id', '=', 'demo')
      .whereRef('parent.id', '!=', 'parent.hub_id')
      .execute()
    expect(nested.map((f) => f.id)).toContain('product-triage')
  })

  it('keeps counters, seq ids, and the revision log consistent', async () => {
    const mismatched = await sql<{ id: string }>`
      SELECT f.id FROM folder f
      WHERE f.item_count <> (
        SELECT count(*) FROM item i
        WHERE i.workspace_id = f.workspace_id
          AND (CASE WHEN f.parent_id IS NULL THEN i.hub_id ELSE i.folder_id END) = f.id
      )`.execute(db)
    expect(mismatched.rows).toEqual([])

    const ws = await db.selectFrom('workspace').select(['id', 'next_revision_seq']).execute()
    for (const { id, next_revision_seq } of ws) {
      const { n } = await db
        .selectFrom('revision')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('workspace_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(next_revision_seq).toBe(n + 1)
    }

    const badSeq = await sql<{ id: string }>`
      SELECT h.id FROM folder h
      WHERE h.parent_id IS NULL
        AND h.next_seq <> 1 + (SELECT count(*) FROM item i WHERE i.workspace_id = h.workspace_id AND i.hub_id = h.id)`.execute(
      db,
    )
    expect(badSeq.rows).toEqual([])
  })

  it('makes every principal an author, and the dev principal an owner in each workspace', async () => {
    const owners = await db
      .selectFrom('principal')
      .select('workspace_id')
      .where('id', '=', ACTOR)
      .where('workspace_role', '=', 'owner')
      .execute()
    expect(owners.map((o) => o.workspace_id).sort()).toEqual(['acme', 'demo'])

    const authors = await db
      .selectFrom('item')
      .select('updated_by')
      .distinct()
      .where('workspace_id', '=', 'demo')
      .execute()
    expect(authors.map((a) => a.updated_by).sort()).toEqual([
      'dev-owner',
      'leo',
      'mina',
      'triage-bot',
    ])
  })

  it('stores only values that pass the core contracts', async () => {
    for (const ws of demoSeed(ACTOR)) {
      for (const hub of ws.hubs) {
        const items = await db
          .selectFrom('item')
          .select(['folder_id', 'values'])
          .where('workspace_id', '=', ws.id)
          .where('hub_id', '=', hub.id)
          .limit(hub.items + 1)
          .execute()
        expect(items).toHaveLength(hub.items)
        const definitions = new Map<string, Awaited<ReturnType<typeof folderDefinitions>>>()
        for (const item of items) {
          let defs = definitions.get(item.folder_id)
          if (!defs) {
            defs = await folderDefinitions(db, ws.id, item.folder_id)
            definitions.set(item.folder_id, defs)
          }
          expect(validateItemValues(defs, item.values, { partial: false }).ok).toBe(true)
        }
      }
    }
  })

  it('writes nothing on a second run', async () => {
    const before = await tableCounts()
    const result = await applySeed(db, { devPrincipalId: ACTOR })
    expect(result.itemsCreated).toBe(0)
    expect(await tableCounts()).toEqual(before)
  }, 60_000)

  it('does not bring back an item deleted through the API', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/workspaces/demo/items/hiring-0001?version=1',
      headers: auth,
    })
    expect(res.statusCode).toBe(204)

    const result = await applySeed(db, { devPrincipalId: ACTOR })
    expect(result.itemsCreated).toBe(0)
    const gone = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/demo/items/hiring-0001',
      headers: auth,
    })
    expect(gone.statusCode).toBe(404)
    const hiring = (await hubs('demo')).find((h) => h.id === 'hiring')
    expect(hiring?.itemCount).toBe(5)
  }, 60_000)

  it('gives no agent a role that manages members or billing (D28)', async () => {
    const agents = await db
      .selectFrom('principal')
      .select(['workspace_id', 'id', 'workspace_role'])
      .where('kind', '=', 'agent')
      .where('workspace_role', 'in', ['owner', 'admin', 'finance'])
      .execute()
    expect(agents).toEqual([])
  })

  it('makes the dev principal owner again if its row has a lower role', async () => {
    await db
      .updateTable('principal')
      .set({ workspace_role: 'member' })
      .where('workspace_id', '=', 'demo')
      .where('id', '=', ACTOR)
      .execute()
    await applySeed(db, { devPrincipalId: ACTOR })
    const row = await db
      .selectFrom('principal')
      .select('workspace_role')
      .where('workspace_id', '=', 'demo')
      .where('id', '=', ACTOR)
      .executeTakeFirstOrThrow()
    expect(row.workspace_role).toBe('owner')
  }, 60_000)

  it('refuses to run with NODE_ENV=production unless --force is passed', async () => {
    const script = fileURLToPath(new URL('./seed.ts', import.meta.url))
    // No DATABASE_URL: the guard must fire before anything else, so nothing can be written.
    const env = { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production' }
    const run = async (args: string[]): Promise<{ code: unknown; stderr: string }> => {
      try {
        await promisify(execFile)(process.execPath, [script, ...args], { env })
        return { code: 0, stderr: '' }
      } catch (error) {
        const { code, stderr } = error as { code: unknown; stderr: string }
        return { code, stderr }
      }
    }
    const refused = await run([])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('NODE_ENV=production')
    const forced = await run(['--force'])
    expect(forced.code).toBe(1)
    expect(forced.stderr).toContain('DATABASE_URL is not set')
  }, 30_000)

  it('gets --force from `pnpm seed` through the root and filtered scripts', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    // Under `pnpm test`, npm_execpath is the pnpm running the tests.
    const pnpm = process.env['npm_execpath'] ?? 'pnpm'
    // DATABASE_URL is set but empty, so the scripts' --env-file-if-exists cannot fill it in from
    // a local .env: the seed must stop at the URL check and can never reach a database.
    const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: '' }
    const run = async (args: string[]): Promise<string> => {
      try {
        await promisify(execFile)(pnpm, args, { cwd: root, env })
        return ''
      } catch (error) {
        return (error as { stderr: string; stdout: string }).stderr
      }
    }
    for (const args of [
      ['seed', '--force'],
      ['--filter', '@16bit/api', 'seed', '--force'],
    ]) {
      const stderr = await run(args)
      expect(stderr, args.join(' ')).toContain('DATABASE_URL is not set')
      expect(stderr, args.join(' ')).not.toContain('refusing to run')
    }
    expect(await run(['seed'])).toContain('refusing to run with NODE_ENV=production')
  }, 60_000)

  // Must stay the last test: it leaves the hub's next_seq ahead of its item count.
  it('fills in a workspace that is only partly seeded', async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('revision')
        .where('workspace_id', '=', 'acme')
        .where('item_id', '=', 'events-0003')
        .execute()
      await trx
        .deleteFrom('item')
        .where('workspace_id', '=', 'acme')
        .where('id', '=', 'events-0003')
        .execute()
      await trx
        .updateTable('folder')
        .set({ item_count: sql`item_count - 1` })
        .where('workspace_id', '=', 'acme')
        .where('id', '=', 'events')
        .execute()
    })
    const result = await applySeed(db, { devPrincipalId: ACTOR })
    expect(result.itemsCreated).toBe(1)
    const events = (await hubs('acme')).find((h) => h.id === 'events')
    expect(events?.itemCount).toBe(3)
  }, 60_000)
})
