import { buildApp } from './app.ts'
import { createDb } from './db/database.ts'
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

// The pool connects lazily, so the server starts even while Postgres is still coming up.
const db = createDb(databaseUrl)
// Secure cookies unless explicitly turned off for plain-HTTP local development.
const secureCookies = process.env['COOKIE_SECURE'] !== 'false'
const refuseDevPassword = devPasswordRefused(process.env)
if (process.env['NODE_ENV'] === 'production' && !refuseDevPassword) {
  console.warn("api: ALLOW_DEV_PASSWORD=1, the seeds' published password signs in. Local only.")
}
const app = buildApp({ db, webRoot, secureCookies, refuseDevPassword })

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

try {
  const address = await app.listen({ port, host })
  console.log(`api listening on ${address}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
