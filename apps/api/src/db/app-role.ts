import pg from 'pg'
import { APP_ROLE } from './scope.ts'

// The API's database user (#44): a login role in the group `sixteenbit_app`, which migration
// 0008 grants privileges to. For local development and CI, `pnpm db:migrate` creates it from the
// user and password in DATABASE_URL when it does not exist yet. In a deployment, create it
// yourself (`CREATE ROLE ... LOGIN PASSWORD ... IN ROLE sixteenbit_app`) and give the migration
// job MIGRATION_DATABASE_URL only.

const ALREADY_EXISTS = new Set(['42710', '23505']) // duplicate_object, unique_violation (races)

async function createIgnoringRace(client: pg.Client, statement: string): Promise<void> {
  try {
    await client.query(statement)
  } catch (error) {
    if (!ALREADY_EXISTS.has((error as { code?: string }).code ?? '')) throw error
  }
}

/**
 * Makes sure the user in `appUrl` can log in as a member of `sixteenbit_app`, connecting with
 * `ownerUrl`. Creates the role if missing; an existing one is left alone but must not be a
 * superuser, bypass RLS, or sit outside the group. Returns the role name, or null when `appUrl`
 * uses the owner's own user (nothing to do; the API will refuse to start with it).
 */
export async function ensureAppLogin(ownerUrl: string, appUrl: string): Promise<string | null> {
  const owner = new URL(ownerUrl)
  const app = new URL(appUrl)
  const role = decodeURIComponent(app.username)
  if (!role || role === decodeURIComponent(owner.username)) return null
  if (role === APP_ROLE) {
    throw new Error(`DATABASE_URL must use a login role in ${APP_ROLE}, not ${APP_ROLE} itself`)
  }

  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    await createIgnoringRace(
      client,
      `CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    )
    const { rows } = await client.query<{ superuser: boolean; bypass: boolean }>(
      'SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = $1',
      [role],
    )
    const existing = rows[0]
    if (!existing) {
      const password = decodeURIComponent(app.password)
      await createIgnoringRace(
        client,
        `CREATE ROLE ${client.escapeIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(password)}
           NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE ${APP_ROLE}`,
      )
      return role
    }
    if (existing.superuser || existing.bypass) {
      throw new Error(`role ${role} is a superuser or bypasses row-level security`)
    }
    const member = await client.query<{ ok: boolean }>(
      `SELECT pg_has_role($1, '${APP_ROLE}', 'USAGE') AS ok`,
      [role],
    )
    if (!member.rows[0]?.ok) throw new Error(`role ${role} is not a member of ${APP_ROLE}`)
    return role
  } finally {
    await client.end()
  }
}
