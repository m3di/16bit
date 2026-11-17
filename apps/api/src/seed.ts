// Entry point for `pnpm seed`: applies pending migrations, then loads the demo workspaces, their
// people and one agent key. Safe to run again: existing rows are left alone and nothing is
// duplicated. DEVELOPMENT ONLY: every seeded account has the published password DEV_PASSWORD.
import { createDb, migrateToLatest } from './db/database.ts'
import { applySeed } from './demo-seed.ts'
import { DEV_PASSWORD } from './dev-accounts.ts'

// The seed creates owners with a published password, so it must never reach a production
// database by accident.
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
  const { workspaces, itemsCreated, accounts, agentKey } = await applySeed(db)
  console.log(`seed: ${String(workspaces)} workspaces, ${String(itemsCreated)} items created`)
  console.log(`seed: sign in as any of ${accounts.join(', ')}`)
  console.log(`seed: development password for all of them: ${DEV_PASSWORD}`)
  if (agentKey) {
    console.log(
      `seed: agent key for hub ${agentKey.hubId} in workspace ${agentKey.workspaceId}. ` +
        'Shown once, not stored; copy it now:',
    )
    console.log(agentKey.secret)
  } else {
    console.log('seed: the agent key exists already; its secret was shown when it was created')
  }
} catch (error) {
  console.error('seed: failed:', error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
