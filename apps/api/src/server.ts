import { buildApp } from './app.ts'
import { createDb } from './db/database.ts'

const port = Number(process.env['PORT'] ?? 3000)
const host = process.env['HOST'] ?? '127.0.0.1'
const databaseUrl = process.env['DATABASE_URL']
const devApiKey = process.env['DEV_API_KEY']
const devPrincipalId = process.env['DEV_PRINCIPAL_ID'] ?? 'dev-owner'

if (!databaseUrl || !devApiKey) {
  console.error('api: DATABASE_URL and DEV_API_KEY must be set. See .env.example.')
  process.exit(1)
}

// The pool connects lazily, so the server starts even while Postgres is still coming up.
const db = createDb(databaseUrl)
const app = buildApp({ db, devApiKey, devPrincipalId })

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
