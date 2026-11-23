import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { applyLargeSeed, LARGE_ATTR, LARGE_FOLDER, LARGE_WORKSPACE } from './large-seed.ts'

// The aggregate engine's timing budget on a small hub (D80). A wall-clock bound, so it is not
// part of `pnpm test`: CI runs it alone, after the main suite, with `pnpm test:budgets` (#293).
// The engine's behaviour is in aggregate.test.ts.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance | undefined

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
}, 60_000)

afterEach(async () => {
  await app?.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

describe('aggregate budget', () => {
  it('answers a group and 5 measures on a 2,000-item hub in under 200 ms (D80)', async () => {
    await applyLargeSeed(db, { items: 2_000 })
    await sql`
      INSERT INTO principal (workspace_id, id, kind, name, workspace_role)
        VALUES (${sql.lit(LARGE_WORKSPACE.id)}, 'agg-editor', 'user', 'Editor', 'member');
      INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role)
        VALUES (${sql.lit(LARGE_WORKSPACE.id)}, 'large', 'agg-editor', 'editor');
      ANALYZE;
    `.execute(db)
    const server = buildApp({ db: appDb })
    app = server
    const headers = { cookie: (await sessionCookie(db, 'agg-editor')).cookie }
    const body = {
      from: LARGE_FOLDER.id,
      groupBy: { attribute: LARGE_ATTR.stage },
      measures: [
        { fn: 'count' },
        { fn: 'sum', attribute: LARGE_ATTR.effort },
        { fn: 'count', where: { attribute: LARGE_ATTR.tags, op: 'in', value: ['api'] } },
        {
          fn: 'avg',
          attribute: LARGE_ATTR.effort,
          where: { attribute: LARGE_ATTR.due, op: 'lt', value: { $now: 'P0D' } },
        },
        { fn: 'count_empty', attribute: LARGE_ATTR.due },
      ],
    }
    const run = async () => {
      const started = performance.now()
      const res = await server.inject({
        method: 'POST',
        url: `/v1/workspaces/${LARGE_WORKSPACE.id}/aggregate`,
        headers,
        payload: body,
      })
      const ms = performance.now() - started
      expect(res.statusCode, res.body).toBe(200)
      return ms
    }
    await run()
    const ms = Math.min(await run(), await run(), await run())
    console.info(`aggregate, 2,000 items: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(200)
  }, 60_000)
})
