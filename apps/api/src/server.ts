import { buildApp } from './app.ts'
import { createDb } from './db/database.ts'
import { checkDevAnonymous } from './dev-anonymous.ts'

const port = Number(process.env['PORT'] ?? 3000)
const host = process.env['HOST'] ?? '127.0.0.1'
const databaseUrl = process.env['DATABASE_URL']
const devApiKey = process.env['DEV_API_KEY']
const devPrincipalId = process.env['DEV_PRINCIPAL_ID'] ?? 'dev-owner'
// Set in the container image, which serves the built web app from the same port.
const webRoot = process.env['WEB_ROOT'] || undefined
const devAnonymous = checkDevAnonymous(process.env, host)

if (!databaseUrl || !devApiKey) {
  console.error('api: DATABASE_URL and DEV_API_KEY must be set. See .env.example.')
  process.exit(1)
}
if ('error' in devAnonymous) {
  console.error(devAnonymous.error)
  process.exit(1)
}
if ('warning' in devAnonymous) console.warn(devAnonymous.warning)
const anonymousAsDevPrincipal = devAnonymous.enabled

// The pool connects lazily, so the server starts even while Postgres is still coming up.
const db = createDb(databaseUrl)
// Secure cookies unless explicitly turned off for plain-HTTP local development.
const secureCookies = process.env['COOKIE_SECURE'] !== 'false'
const app = buildApp({
  db,
  devApiKey,
  devPrincipalId,
  webRoot,
  anonymousAsDevPrincipal,
  secureCookies,
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

try {
  const address = await app.listen({ port, host })
  console.log(`api listening on ${address}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
