// Entry point for `pnpm seed:build-hub`. Needs `gh` signed in with read access to the repo.
// BUILD_HUB_REPO (`owner/name`) picks the repository; without it gh uses the current checkout.
import {
  buildHubItemCount,
  ensureBuildHub,
  fetchIssues,
  importIssues,
  ISSUE_LIMIT,
} from './build-hub.ts'
import { createDb, migrateToLatest } from './db/database.ts'
import { DEV_OWNER } from './dev-accounts.ts'

if (process.env['NODE_ENV'] === 'production' && !process.argv.includes('--force')) {
  console.error(
    'seed:build-hub: refusing to run with NODE_ENV=production. Pass --force to override.',
  )
  process.exit(1)
}

// Runs as the owner of the tables, like migrations (#44).
const databaseUrl = process.env['MIGRATION_DATABASE_URL']
if (!databaseUrl) {
  console.error('seed:build-hub: MIGRATION_DATABASE_URL is not set. See .env.example.')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  const issues = await fetchIssues(process.env['BUILD_HUB_REPO'] || undefined)
  if (issues.length >= ISSUE_LIMIT) {
    console.warn(`seed:build-hub: read the first ${String(ISSUE_LIMIT)} issues only`)
  }
  await migrateToLatest(db)
  await ensureBuildHub(db)
  const { created, updated, unchanged, skipped, failed } = await importIssues(db, issues)
  console.log(
    `seed:build-hub: ${String(issues.length)} issues, ${String(created)} created, ` +
      `${String(updated)} updated, ${String(unchanged)} unchanged, ${String(failed.length)} failed; ` +
      `hub has ${String(await buildHubItemCount(db))} items`,
  )
  if (skipped.length > 0) {
    console.log(`seed:build-hub: deleted locally, not re-imported: #${skipped.join(', #')}`)
  }
  console.log(`seed:build-hub: sign in as ${DEV_OWNER.email} to see the hub`)
  if (failed.length > 0) {
    console.error(`seed:build-hub: ${String(failed.length)} issues not imported:`)
    for (const f of failed) console.error(`  #${String(f.issue)} ${f.code}: ${f.message}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`seed:build-hub: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await db.destroy()
}
