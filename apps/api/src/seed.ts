// Entry point for `pnpm seed`: applies pending migrations, then loads the demo workspaces.
// Safe to run again: existing rows are left alone and nothing is duplicated.
import { createDb, migrateToLatest } from './db/database.ts'
import { applySeed } from './demo-seed.ts'

// The seed creates an owner principal, so it must never reach a production database by accident.
if (process.env['NODE_ENV'] === 'production' && !process.argv.includes('--force')) {
  console.error('seed: refusing to run with NODE_ENV=production. Pass --force to override.')
  process.exit(1)
}

// Runs as the owner of the tables, like migrations (#44).
const databaseUrl = process.env['MIGRATION_DATABASE_URL']
if (!databaseUrl) {
  console.error('seed: MIGRATION_DATABASE_URL is not set. See .env.example.')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  await migrateToLatest(db)
  const { workspaces, itemsCreated } = await applySeed(db, {
    devPrincipalId: process.env['DEV_PRINCIPAL_ID'] ?? 'dev-owner',
  })
  console.log(`seed: ${String(workspaces)} workspaces, ${String(itemsCreated)} items created`)
} catch (error) {
  console.error('seed: failed:', error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
