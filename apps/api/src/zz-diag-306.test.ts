import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { withScope } from './db/scope.ts'
import { createTestDatabase } from './db/test-database.ts'
import { createSession, DEFAULT_SESSION_POLICY, SESSION_COOKIE } from './auth/session.ts'
import { DEV_OWNER } from './dev-accounts.ts'
import {
  applyProjectSeed,
  generatedTasks,
  PROJECT_TASKS,
  SCALE_HUB,
  seedProjectWorkspace,
} from './project-seed.ts'

// TEMPORARY diagnostic for issue 306, CI only: times the three slow home blocks on the
// 2,000-task hub before and after ANALYZE, and prints the plans of their slow statements.
// Removed before the fix is ready for review.

let db: Kysely<Database>
let logged: Kysely<Database>
let drop: () => Promise<void>
const slow: { sql: string; parameters: readonly unknown[]; ms: number }[] = []

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  // No statistics until the test asks for them, as on a fresh database before autovacuum.
  await sql`
    ALTER TABLE item SET (autovacuum_enabled = false);
    ALTER TABLE item_index SET (autovacuum_enabled = false);
    ALTER TABLE link SET (autovacuum_enabled = false);
  `.execute(db)
  await seedProjectWorkspace(db, SCALE_HUB)
  await applyProjectSeed(db, { hub: SCALE_HUB, tasks: generatedTasks(PROJECT_TASKS) })
  const types = new pg.TypeOverrides()
  types.setTypeParser(pg.types.builtins.INT8, Number)
  const pool = new pg.Pool({ connectionString: test.appUrl, max: 10, types })
  logged = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log(event) {
      if (event.level === 'query' && event.queryDurationMillis > 150) {
        slow.push({
          sql: event.query.sql,
          parameters: event.query.parameters,
          ms: event.queryDurationMillis,
        })
      }
    },
  })
}, 600_000)

afterAll(async () => {
  await logged.destroy()
  await db.destroy()
  await drop()
})

async function round(label: string) {
  const app = buildApp({ db: logged })
  const row = await db
    .selectFrom('principal')
    .select('account_id')
    .where('workspace_id', '=', 'large')
    .where('id', '=', DEV_OWNER.id)
    .executeTakeFirstOrThrow()
  const token = await createSession(db, row.account_id ?? '', DEFAULT_SESSION_POLICY)
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  for (const block of ['team-points', 'epic-bars', 'burndown', 'points-done']) {
    slow.length = 0
    const started = performance.now()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/large/folders/scale-home/view/data?version=1&blocks=${block}&tz=UTC`,
      headers,
    })
    const ms = Math.round(performance.now() - started)
    console.log(`DIAG306 ${label} ${block} status=${String(res.statusCode)} ms=${String(ms)}`)
    for (const q of [...slow]) {
      console.log(`DIAG306 ${label} ${block} slow statement ${String(Math.round(q.ms))} ms`)
      const plan = await withScope(
        logged,
        { workspaceId: 'large', principalId: DEV_OWNER.id },
        async (trx) => {
          await sql`SET LOCAL work_mem = '32MB'`.execute(trx)
          const r = await trx.executeQuery<{ 'QUERY PLAN': string }>(
            CompiledQuery.raw(`EXPLAIN (ANALYZE, COSTS, TIMING OFF) ${q.sql}`, [...q.parameters]),
          )
          return r.rows.map((row) => row['QUERY PLAN']).join('\n')
        },
      )
      console.log(`DIAG306 PLAN ${label} ${block}\n${plan}\nDIAG306 END`)
    }
  }
  await app.close()
}

it('diagnoses issue 306', async () => {
  const { rows } = await sql<{
    relname: string
    n_live_tup: number
    last_analyze: unknown
    last_autoanalyze: unknown
  }>`
    SELECT relname, n_live_tup, last_analyze, last_autoanalyze FROM pg_stat_user_tables
    WHERE relname IN ('item', 'item_index', 'link')
  `.execute(db)
  console.log(`DIAG306 stats ${JSON.stringify(rows)}`)
  await round('before')
  await sql`ANALYZE item, item_index, link`.execute(db)
  await round('after')
}, 600_000)
