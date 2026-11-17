// Entry point for `pnpm db:migrate`, also run by `pnpm dev` before the servers start.
// Migrations run as the owner of the tables (MIGRATION_DATABASE_URL). With DATABASE_URL set as
// well, the API's login role is then created if it does not exist yet (local and CI, #44).
import { ensureAppLogin } from './db/app-role.ts'
import { createDb, migrateToLatest } from './db/database.ts'

const migrationUrl = process.env['MIGRATION_DATABASE_URL']
const appUrl = process.env['DATABASE_URL']
if (!migrationUrl) {
  console.error('migrate: MIGRATION_DATABASE_URL is not set. See .env.example.')
  process.exit(1)
}

const db = createDb(migrationUrl)
try {
  const applied = await migrateToLatest(db)
  console.log(applied.length ? `migrate: applied ${applied.join(', ')}` : 'migrate: up to date')
  if (appUrl) {
    const role = await ensureAppLogin(migrationUrl, appUrl)
    if (role) console.log(`migrate: API role ${role} is ready`)
  }
} catch (error) {
  const cause = (error as Error).cause
  console.error(`migrate: ${(error as Error).message}`, ...(cause ? [cause] : []))
  process.exitCode = 1
} finally {
  await db.destroy()
}
