import { buildApp } from './app.ts'
import { createDb } from './db/database.ts'
import { unsafeRoleReason } from './db/scope.ts'
import { devPasswordRefused } from './dev-accounts.ts'

const port = Number(process.env['PORT'] ?? 3000)
const host = process.env['HOST'] ?? '127.0.0.1'
const databaseUrl = process.env['DATABASE_URL']
// Set in the container image, which serves the built web app from the same port.
const webRoot = process.env['WEB_ROOT'] || undefined

if (!databaseUrl) {
  console.error('api: DATABASE_URL must be set. See .env.example.')
  process.exit(1)
}

// DATABASE_URL is the API's role, under row-level security (#44). The API has no other
// connection: the owner's MIGRATION_DATABASE_URL is for migrations and seeds only.
const db = createDb(databaseUrl)
// Secure cookies unless explicitly turned off for plain-HTTP local development.
const secureCookies = process.env['COOKIE_SECURE'] !== 'false'
const refuseDevPassword = devPasswordRefused(process.env)
if (process.env['NODE_ENV'] === 'production' && !refuseDevPassword) {
  console.warn("api: ALLOW_DEV_PASSWORD=1, the seeds' published password signs in. Local only.")
}
const app = buildApp({
  db,
  webRoot,
  secureCookies,
  refuseDevPassword,
  feed: { listenUrl: databaseUrl },
})

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`api received ${signal}, closing`)
  try {
    await app.close()
    await db.destroy()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

// `once`: a second signal falls through to the default handler and exits at once.
process.once('SIGINT', (signal) => void shutdown(signal))
process.once('SIGTERM', (signal) => void shutdown(signal))

/**
 * Exits if DATABASE_URL connects as a role row-level security does not apply to (the owner, a
 * superuser, BYPASSRLS). Waits for Postgres, retrying, and runs before the server binds, so
 * not even one request is served with the wrong role.
 */
async function guardRole(): Promise<void> {
  for (;;) {
    let reason: string | null
    try {
      reason = await unsafeRoleReason(db)
    } catch (error) {
      // Not reachable yet (a socket error, or SQLSTATE 08xxx / 57P0x): try again. Any other
      // database error, such as a missing role or table, will not go away by waiting.
      const raw = (error as { code?: unknown }).code
      const code = typeof raw === 'string' ? raw : ''
      if (/^[0-9A-Z]{5}$/.test(code) && !/^(08|57P)/.test(code)) {
        console.error(`api: refusing to serve: ${(error as Error).message}`)
        process.exit(1)
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
      continue
    }
    if (reason === null) return
    console.error(
      `api: refusing to serve: ${reason}. DATABASE_URL must be the API's own role ` +
        `(see .env.example); migrations use MIGRATION_DATABASE_URL.`,
    )
    process.exit(1)
  }
}

try {
  await guardRole()
  const address = await app.listen({ port, host })
  console.log(`api listening on ${address}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
