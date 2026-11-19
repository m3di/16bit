import { sql, type Transaction } from 'kysely'
import type { Database } from './db/database.ts'

// A transaction-scoped advisory lock per hub that keeps item values in step with the hub's
// attributes (#112). Item creates and patches read the folder's attributes and validate against
// them, then write; a schema write that strips values (removing an option or an attribute) must
// not commit between the two, or the item would keep a value for an option or attribute that is
// gone. Item creates and patches take the lock shared, before they read the attributes, so they
// run side by side; stripping writes take it exclusive, before they lock the attribute row.
//
// Advisory locks need no table privilege and no row-level security, which matters here: editors
// cannot lock `attribute` rows, whose UPDATE policy admits hub admins only (migration 0009). A
// hash collision between two hubs only makes them wait for each other.

/** Takes the hub's schema lock until the transaction ends. */
export async function lockHubSchema(
  trx: Transaction<Database>,
  workspaceId: string,
  hubId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const key = sql`hashtextextended(${`16bit.hub-schema:${workspaceId}:${hubId}`}, 0)`
  if (mode === 'shared') await sql`SELECT pg_advisory_xact_lock_shared(${key})`.execute(trx)
  else await sql`SELECT pg_advisory_xact_lock(${key})`.execute(trx)
}
