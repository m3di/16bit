import { itemQueryResultSchema, type ItemQueryResult } from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { DEV_OWNER, DEV_PASSWORD } from './dev-accounts.ts'
import { itemQueryStatement, type ItemQuery } from './items.ts'
import {
  applyLargeSeed,
  LARGE_ATTR,
  LARGE_FOLDER,
  LARGE_ITEMS,
  LARGE_WORKSPACE,
} from './large-seed.ts'

// Windows on the 50,000-item folder of `pnpm seed:large` (D61): the timing bounds, which are the
// real check, and the plans Postgres picks with its own costs. The folder is the whole `item`
// table here, so at deep offsets Postgres may rightly read the table and sort instead of walking
// the index (#172); these tests only promise the index at shallow offsets. query.test.ts proves
// the SQL can use the index at any offset. The tests only read, so they share one database.

const WS = LARGE_WORKSPACE.id
const FROM = LARGE_FOLDER.id

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let cookie: string

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  const seeded = await applyLargeSeed(db)
  expect(seeded.folderItems).toBe(LARGE_ITEMS)
  // Fresh statistics, as autovacuum would have them on a live database.
  await sql`ANALYZE`.execute(db)

  app = buildApp({ db: appDb })
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: DEV_OWNER.email, password: DEV_PASSWORD },
  })
  expect(login.statusCode, login.body).toBe(200)
  const setCookie = login.headers['set-cookie']
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? ''
}, 180_000)

afterAll(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/** One query through the API, and how long it took end to end. */
async function timed(body: object): Promise<{ page: ItemQueryResult; ms: number }> {
  const started = performance.now()
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/query`,
    headers: { cookie },
    payload: { from: FROM, limit: 200, ...body },
  })
  const ms = performance.now() - started
  expect(res.statusCode, res.body).toBe(200)
  return { page: itemQueryResultSchema.parse(res.json()), ms }
}

describe('windows on a 50,000-item folder (D61)', () => {
  it('answers the last window of the number order, with the total, in under 500 ms', async () => {
    // The folder table loads the top first, so the connection and caches are warm.
    await timed({ order: 'number', count: true })
    const { page, ms } = await timed({ order: 'number', offset: 49_800, count: true })
    expect(page.total).toBe(LARGE_ITEMS)
    expect(page.items.map((i) => i.seqId)).toEqual(Array.from({ length: 200 }, (_, i) => 200 - i))
    expect(page.nextCursor).toBeNull()
    expect(ms).toBeLessThan(500)
  })

  it('answers a deep window of the updated order in under 500 ms', async () => {
    const { page, ms } = await timed({ offset: 49_800 })
    expect(page.items).toHaveLength(200)
    expect(ms).toBeLessThan(500)
  })

  it('answers a window with an attribute sort, a filter and the total in under two seconds', async () => {
    const where = {
      and: [
        { attribute: LARGE_ATTR.effort, op: 'is_not_empty' },
        { attribute: LARGE_ATTR.stage, op: 'is_not_empty' },
      ],
    }
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM item i
      WHERE i.workspace_id = ${WS} AND i.folder_id = ${FROM}
        AND EXISTS (SELECT 1 FROM item_index x WHERE x.workspace_id = ${WS}
                    AND x.attribute_id = ${LARGE_ATTR.effort} AND x.item_id = i.id)
        AND EXISTS (SELECT 1 FROM item_index x WHERE x.workspace_id = ${WS}
                    AND x.attribute_id = ${LARGE_ATTR.stage} AND x.item_id = i.id)
    `.execute(db)
    const matching = rows[0]?.n ?? 0
    expect(matching).toBeGreaterThan(30_000)

    const { page, ms } = await timed({
      where,
      sort: [{ attribute: LARGE_ATTR.title }],
      offset: matching - 300,
      count: true,
    })
    expect(page.total).toBe(matching)
    expect(page.items).toHaveLength(200)
    expect(ms).toBeLessThan(2_000)
  })
})

describe('plans Postgres picks on a 50,000-item folder (D20, D61)', () => {
  async function plan(query: Partial<ItemQuery>): Promise<string> {
    const full: ItemQuery = {
      from: FROM,
      where: null,
      sort: [],
      limit: 200,
      cursor: null,
      ...query,
    }
    const { statement } = await itemQueryStatement(db, WS, full)
    const { rows } = await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${statement}`.execute(db)
    return rows.map((r) => r['QUERY PLAN']).join('\n')
  }

  it.each(['updated', 'number'] as const)(
    'walks item_folder_%s_idx with no sort at shallow offsets',
    async (order) => {
      for (const offset of [0, 1_000]) {
        const window = await plan({ order, offset })
        expect(window, `offset ${String(offset)}`).toContain(`item_folder_${order}_idx`)
        expect(window, `offset ${String(offset)}`).not.toMatch(/Sort/)
      }
    },
  )
})
