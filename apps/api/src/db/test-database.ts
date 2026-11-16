import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Integration tests run against a real Postgres. Each call creates an empty database
// next to the one in DATABASE_URL and returns its URL plus a function that drops it.

function baseUrl(): string {
  const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url))
  if (!process.env['DATABASE_URL'] && existsSync(envFile)) process.loadEnvFile(envFile)
  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error('DATABASE_URL is not set. Start Postgres with `docker compose up -d db`.')
  }
  return url
}

export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = baseUrl()
  const name = `test_${randomBytes(6).toString('hex')}`
  const client = new pg.Client({ connectionString: admin })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${name}`)
  } finally {
    await client.end()
  }

  const url = new URL(admin)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: admin })
      await c.connect()
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await c.end()
      }
    },
  }
}
