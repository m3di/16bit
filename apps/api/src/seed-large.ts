// Entry point for `pnpm seed:large` (#173): applies pending migrations, then fills the Large hub
// in the `large` workspace with 50,000 items. Safe to run again. With `--project`, it adds the
// project-shaped hub "Parcel Tracker at scale" to the same workspace instead, with 2,000 tasks
// (project-seed.ts; the M4-04 and M4-12 budgets). DEVELOPMENT ONLY: the dev owner's
// account has the published password DEV_PASSWORD.
import { createDb, migrateToLatest } from './db/database.ts'
import { DEV_OWNER } from './dev-accounts.ts'
import { applyLargeSeed, LARGE_FOLDER, LARGE_WORKSPACE } from './large-seed.ts'
import {
  applyProjectSeed,
  generatedTasks,
  PROJECT_TASKS,
  SCALE_HUB,
  seedProjectWorkspace,
} from './project-seed.ts'

if (process.env['NODE_ENV'] === 'production' && !process.argv.includes('--force')) {
  console.error('seed:large: refusing to run with NODE_ENV=production. Pass --force to override.')
  process.exit(1)
}

// Runs as the owner of the tables, like migrations (#44).
const databaseUrl = process.env['MIGRATION_DATABASE_URL']
if (!databaseUrl) {
  console.error('seed:large: MIGRATION_DATABASE_URL is not set. See .env.example.')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  await migrateToLatest(db)
  const started = performance.now()
  if (process.argv.includes('--project')) {
    await seedProjectWorkspace(db, SCALE_HUB)
    const project = await applyProjectSeed(db, {
      hub: SCALE_HUB,
      tasks: generatedTasks(PROJECT_TASKS),
    })
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.log(
      project.hubDeleted
        ? `seed:large: the ${SCALE_HUB.name} hub was deleted through the API; nothing written`
        : `seed:large: ${SCALE_HUB.name}: ${String(project.itemsCreated)} items created in ` +
            `${seconds}s in workspace ${SCALE_HUB.workspaceId}`,
    )
  } else {
    const { hubDeleted, created, folderItems } = await applyLargeSeed(db)
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    if (hubDeleted) {
      console.log(
        'seed:large: the Large hub was deleted through the API, so nothing was written. ' +
          'A deleted hub keeps its ID out of use, so it only comes back on a fresh database.',
      )
    } else {
      console.log(
        `seed:large: ${String(created)} items created in ${seconds}s; ` +
          `folder ${LARGE_FOLDER.id} in workspace ${LARGE_WORKSPACE.id} has ${String(folderItems)} items`,
      )
      console.log(`seed:large: sign in as ${DEV_OWNER.email} to see it`)
    }
  }
} catch (error) {
  console.error('seed:large: failed:', error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
