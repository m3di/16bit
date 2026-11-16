// Entry point for `pnpm db:migrate`, also run by `pnpm dev` before the servers start.
import { createDb, migrateToLatest } from './db/database.ts'

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is not set. See .env.example.')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  const applied = await migrateToLatest(db)
  console.log(applied.length ? `migrate: applied ${applied.join(', ')}` : 'migrate: up to date')
} catch (error) {
  console.error(`migrate: ${(error as Error).message}:`, (error as Error).cause)
  process.exitCode = 1
} finally {
  await db.destroy()
}
