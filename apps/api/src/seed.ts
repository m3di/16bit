// Entry point for `pnpm seed`: applies pending migrations, then loads the demo workspaces, their
// people and one agent key, then the Parcel Tracker project hub in `demo` (project-seed.ts), whose
// agent key's secret goes to a gitignored file for e2e (`PROJECT_AGENT_KEY_FILE`). Safe to run
// again: existing rows are left alone and nothing is duplicated. DEVELOPMENT ONLY: every seeded account has the published password DEV_PASSWORD.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, migrateToLatest } from './db/database.ts'
import { applySeed } from './demo-seed.ts'
import { DEV_PASSWORD } from './dev-accounts.ts'
import { applyProjectSeed, PARCEL_HUB } from './project-seed.ts'

/**
 * Where the project hub's agent key goes on the run that creates it: under `e2e/.auth/`, which
 * .gitignore keeps out of the repository. Mode 0600. Override with `SEED_AGENT_KEY_FILE`.
 */
const PROJECT_AGENT_KEY_FILE =
  process.env['SEED_AGENT_KEY_FILE'] ??
  fileURLToPath(new URL('../../../e2e/.auth/parcel-agent-key.json', import.meta.url))

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

  const project = await applyProjectSeed(db)
  if (project.hubDeleted) {
    console.log(`seed: the ${PARCEL_HUB.name} hub was deleted through the API; left as it is`)
  } else {
    console.log(
      `seed: ${PARCEL_HUB.name}: ${String(project.itemsCreated)} items created, views stored: ` +
        (project.viewsStored.length > 0
          ? project.viewsStored.join(', ')
          : 'none (kept as they are)'),
    )
    console.log(`seed: ${PARCEL_HUB.name} people: ${project.accounts.join(', ')}`)
    if (project.agentKey) {
      // For e2e, in a file outside git. Where it can't be written (the container image), shown
      // once instead, like the demo key.
      try {
        await mkdir(dirname(PROJECT_AGENT_KEY_FILE), { recursive: true })
        await writeFile(PROJECT_AGENT_KEY_FILE, `${JSON.stringify(project.agentKey, null, 2)}\n`, {
          mode: 0o600,
        })
        console.log(`seed: ${PARCEL_HUB.name} agent key written to ${PROJECT_AGENT_KEY_FILE}`)
      } catch (error) {
        console.log(
          `seed: could not write ${PROJECT_AGENT_KEY_FILE} (${(error as Error).message}). ` +
            `${PARCEL_HUB.name} agent key, shown once, not stored; copy it now:`,
        )
        console.log(project.agentKey.secret)
      }
    } else {
      console.log(
        `seed: the ${PARCEL_HUB.name} agent key exists already; its secret is in ` +
          `${PROJECT_AGENT_KEY_FILE} from the run that created it`,
      )
    }
  }
} catch (error) {
  console.error('seed: failed:', error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
