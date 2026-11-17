import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ensureAppLogin } from './app-role.ts'

// Integration tests run against a real Postgres. Each call creates an empty database next to the
// one in MIGRATION_DATABASE_URL and returns two URLs for it: `url` connects as the owner (for
// migrations and fixtures), `appUrl` as the API's role from DATABASE_URL, under row-level
// security (#44). Plus a function that drops the database.

function urls(): { owner: string; app: string } {
  const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url))
  if (!process.env['MIGRATION_DATABASE_URL'] && existsSync(envFile)) process.loadEnvFile(envFile)
  const owner = process.env['MIGRATION_DATABASE_URL']
  const app = process.env['DATABASE_URL']
  if (!owner || !app) {
    throw new Error(
      'MIGRATION_DATABASE_URL and DATABASE_URL must be set (see .env.example). ' +
        'Start Postgres with `docker compose up -d db`.',
    )
  }
  return { owner, app }
}

export async function createTestDatabase(): Promise<{
  url: string
  appUrl: string
  drop: () => Promise<void>
}> {
  const base = urls()
  // Interpolated into SQL below: safe only because it is random hex. Never pass user input here.
  const name = `test_${randomBytes(6).toString('hex')}`
  const client = new pg.Client({ connectionString: base.owner })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${name}`)
  } finally {
    await client.end()
  }
  await ensureAppLogin(base.owner, base.app)

  const withName = (raw: string) => {
    const url = new URL(raw)
    url.pathname = `/${name}`
    return url.toString()
  }
  return {
    url: withName(base.owner),
    appUrl: withName(base.app),
    drop: async () => {
      const c = new pg.Client({ connectionString: base.owner })
      await c.connect()
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await c.end()
      }
    },
  }
}
