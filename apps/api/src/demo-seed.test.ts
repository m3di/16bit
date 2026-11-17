import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  attributeTypes,
  hubPageSchema,
  meSchema,
  validateItemValues,
  workspacePageSchema,
  type Folder,
  type HubListEntry,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { applySeed, demoSeed, type SeedResult } from './demo-seed.ts'
import { DEV_OWNER, DEV_PASSWORD } from './dev-accounts.ts'
import { folderDefinitions } from './items.ts'

// Integration tests: the demo seed against a fresh, migrated Postgres database. The seed is
// applied once in beforeAll; the later tests run it again, so they depend on test order.

const ACTOR = DEV_OWNER.id

let db: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
/** The dev owner, signed in with the development password. */
let auth: { cookie: string }
let first: SeedResult

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  first = await applySeed(db)
  app = buildApp({ db })
  auth = await signIn(DEV_OWNER.email)
}, 120_000)

afterAll(async () => {
  await app.close()
  await db.destroy()
  await drop()
})

/** Signs in through the API with the development password; returns the cookie to send. */
async function signIn(email: string): Promise<{ cookie: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: DEV_PASSWORD },
  })
  expect(res.statusCode, `${email}: ${res.body}`).toBe(200)
  const setCookie = res.headers['set-cookie']
  const pair = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0]
  if (!pair) throw new Error('no Set-Cookie')
  return { cookie: pair }
}

async function hubList(
  workspaceId: string,
  headers: Record<string, string>,
): Promise<HubListEntry[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}/hubs?limit=50`,
    headers,
  })
  expect(res.statusCode).toBe(200)
  return hubPageSchema.parse(res.json()).items
}

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
    'account',
    'agent_key',
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
  it('creates two workspaces the dev owner sees after signing in', async () => {
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
      'ivy',
      'leo',
      'mina',
      'noor',
      'triage-bot',
    ])
  })

  it('stores only values that pass the core contracts', async () => {
    for (const ws of demoSeed()) {
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
          // Read-only values (auto_id) are the server's; a client may not send them.
          const values = Object.fromEntries(
            Object.entries(item.values).filter(([id]) => {
              const def = defs.find((d) => d.attribute.id === id)
              return !def || !attributeTypes[def.attribute.type].readOnly
            }),
          )
          const result = validateItemValues(defs, values, { partial: false })
          expect(result.ok, JSON.stringify(result)).toBe(true)
        }
      }
    }
  })

  it('writes nothing on a second run', async () => {
    const before = await tableCounts()
    const result = await applySeed(db)
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

    const result = await applySeed(db)
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

  it('lets every seeded person sign in with the development password', async () => {
    const expected: Record<string, [string, string][]> = {
      [DEV_OWNER.email]: [
        ['acme', 'owner'],
        ['demo', 'owner'],
      ],
      'mina@example.com': [['demo', 'admin']],
      'leo@example.com': [['demo', 'member']],
      'ivy@example.com': [['demo', 'viewer']],
      'noor@example.com': [['demo', 'finance']],
      'sam@example.com': [['acme', 'finance']],
    }
    expect(first.accounts).toEqual(Object.keys(expected).sort())
    for (const [email, memberships] of Object.entries(expected)) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: await signIn(email) })
      const me = meSchema.parse(res.json())
      if (me.kind !== 'person') throw new Error(`${email} is not a person`)
      expect(me.account.email).toBe(email)
      const got = me.memberships.map((m) => [m.workspace.id, m.workspaceRole]).sort()
      expect(got, email).toEqual(memberships)
    }
  })

  it('covers every workspace role in one workspace, plus an agent', async () => {
    const roles = await db
      .selectFrom('principal')
      .select(['kind', 'workspace_role'])
      .distinct()
      .where('workspace_id', '=', 'demo')
      .execute()
    expect(roles.map((r) => `${r.kind}:${r.workspace_role}`).sort()).toEqual([
      'agent:member',
      'user:admin',
      'user:finance',
      'user:member',
      'user:owner',
      'user:viewer',
    ])
  })

  it('seeds hub grants that the role matrix caps and hides', async () => {
    const byId = (list: HubListEntry[]) => new Map(list.map((h) => [h.id, h]))
    // An admin sees every hub name, but nothing inside the ones she holds no grant on (D45).
    const mina = byId(await hubList('demo', await signIn('mina@example.com')))
    expect(mina.get('support')).toMatchObject({ access: 'granted', hubRole: 'hub_admin' })
    expect(mina.get('design')).toMatchObject({ access: 'none' })
    // A viewer's editor grant acts as viewer.
    const ivy = byId(await hubList('demo', await signIn('ivy@example.com')))
    expect(ivy.get('launch')).toMatchObject({ access: 'granted', hubRole: 'viewer' })
    expect([...ivy.keys()].sort()).toEqual(['launch', 'product'])
    // Seeded grants are access changes, so they are logged (D48), once.
    const logged = await db
      .selectFrom('access_log')
      .select(['action', 'target', 'detail'])
      .where('workspace_id', '=', 'demo')
      .where('target', '=', 'ivy')
      .execute()
    expect(logged).toHaveLength(2)
    expect(logged.every((l) => l.action === 'grant.set')).toBe(true)
  })

  it('creates one agent key, shows its secret once, and it works as a bearer token', async () => {
    const key = first.agentKey
    if (!key) throw new Error('no agent key on the first run')
    expect(key).toMatchObject({ workspaceId: 'demo', hubId: 'product', principalId: 'triage-bot' })
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${key.secret}` },
    })
    expect(meSchema.parse(me.json())).toMatchObject({
      kind: 'agent',
      principalId: 'triage-bot',
      hub: { id: 'product' },
      hubRole: 'editor',
    })
    const stored = await db.selectFrom('agent_key').select('secret_hash').execute()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.secret_hash).not.toContain(key.secret)
    const log = await db
      .selectFrom('access_log')
      .select('action')
      .where('workspace_id', '=', 'demo')
      .where('target', '=', 'triage-bot')
      .orderBy('seq')
      .execute()
    expect(log.map((l) => l.action)).toEqual(['grant.set', 'key.create'])
  })

  it('has a hub with an attribute of every M1 type, each with values', async () => {
    const attributes = await db
      .selectFrom('attribute')
      .select(['id', 'type'])
      .where('workspace_id', '=', 'demo')
      .where('hub_id', '=', 'launch')
      .execute()
    expect(new Set(attributes.map((a) => a.type))).toEqual(new Set(Object.keys(attributeTypes)))
    const items = await db
      .selectFrom('item')
      .select('values')
      .where('workspace_id', '=', 'demo')
      .where('hub_id', '=', 'launch')
      .execute()
    for (const { id, type } of attributes) {
      const set = items.filter((i) => (i.values as Record<string, unknown>)[id] != null)
      expect(set.length, `${type} values`).toBeGreaterThan(0)
    }
    const links = await db
      .selectFrom('link')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('workspace_id', '=', 'demo')
      .executeTakeFirstOrThrow()
    expect(links.n).toBeGreaterThan(0)
  })

  it('gives no agent a role that manages members or billing (D28)', async () => {
    const agents = await db
      .selectFrom('principal')
      .select(['workspace_id', 'id', 'workspace_role'])
      .where('kind', '=', 'agent')
      .where('workspace_role', 'in', ['owner', 'admin', 'finance'])
      .execute()
    expect(agents).toEqual([])
  })

  it('shows no agent secret on a second run', async () => {
    const result = await applySeed(db)
    expect(result.agentKey).toBeNull()
  }, 60_000)

  it('links a person’s principal from before accounts existed to their account', async () => {
    // As an M0 database left it: the principal is there, with no account.
    await db
      .updateTable('principal')
      .set({ account_id: null })
      .where('workspace_id', '=', 'demo')
      .where('id', '=', 'leo')
      .execute()
    await applySeed(db)
    const row = await db
      .selectFrom('principal')
      .select('account_id')
      .where('workspace_id', '=', 'demo')
      .where('id', '=', 'leo')
      .executeTakeFirstOrThrow()
    expect(row.account_id).toBe('leo')
  }, 60_000)

  it('makes the dev principal owner again if its row has a lower role', async () => {
    await db
      .updateTable('principal')
      .set({ workspace_role: 'member' })
      .where('workspace_id', '=', 'demo')
      .where('id', '=', ACTOR)
      .execute()
    await applySeed(db)
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
    const result = await applySeed(db)
    expect(result.itemsCreated).toBe(1)
    const events = (await hubs('acme')).find((h) => h.id === 'events')
    expect(events?.itemCount).toBe(3)
  }, 60_000)
})
