import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database.ts'

// Row-level security (#44, migration 0008): every query on workspace-scoped tables runs in a
// transaction that first sets the caller with SET LOCAL. Outside one, those tables read as empty.

/** Group role the API's database user belongs to. Owns nothing, cannot bypass RLS. */
export const APP_ROLE = 'sixteenbit_app'

const scopedTransactions = new WeakSet<Transaction<Database>>()

/** True inside `withScope`. Unscoped work is the owner's: migrations, seeds, imports. */
export const isScoped = (db: Kysely<Database>): boolean =>
  db.isTransaction && scopedTransactions.has(db as Transaction<Database>)

/**
 * Runs `fn` in a transaction scoped to `principalId` in `workspaceId`. The settings end with the
 * transaction, so a pooled connection never carries them into the next request.
 *
 * Transactions run at READ COMMITTED. With `snapshot`, it is `REPEATABLE READ READ ONLY`
 * instead: every statement sees one snapshot, so a read of the workspace `seq` is never newer
 * than the rows read with it (D58).
 */
export async function withScope<T>(
  db: Kysely<Database>,
  scope: { workspaceId: string; principalId: string },
  fn: (trx: Transaction<Database>) => Promise<T>,
  options: { snapshot?: boolean } = {},
): Promise<T> {
  let transaction = db.transaction()
  if (options.snapshot) {
    transaction = transaction.setIsolationLevel('repeatable read').setAccessMode('read only')
  }
  return transaction.execute(async (trx) => {
    await sql`
      SELECT set_config('app.workspace_id', ${scope.workspaceId}, true),
             set_config('app.principal_id', ${scope.principalId}, true)
    `.execute(trx)
    scopedTransactions.add(trx)
    return fn(trx)
  })
}

/**
 * Runs `fn` in `db`'s transaction if it is one (a scoped request), else in a new transaction.
 * Write paths use it so they join the request's transaction, and their checks and writes
 * commit together.
 */
export async function inTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return fn(db as Transaction<Database>)
  return db.transaction().execute(fn)
}

/**
 * Why `db` must not serve requests, or null if it is fit: it connects as a superuser, a role that
 * bypasses RLS, or one with the privileges of the tables' owner (RLS does not apply to owners).
 */
export async function unsafeRoleReason(db: Kysely<Database>): Promise<string | null> {
  const { rows } = await sql<{
    role: string
    superuser: boolean
    bypass: boolean
    owner: boolean
    member: boolean
  }>`
    SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
           pg_has_role(current_user, c.relowner, 'USAGE') AS owner,
           pg_has_role(current_user, ${APP_ROLE}, 'USAGE') AS member
    FROM pg_roles r, pg_class c
    WHERE r.rolname = current_user AND c.oid = 'public.item'::regclass
  `.execute(db)
  const row = rows[0]
  if (!row) return 'the database has no item table; run migrations first'
  if (row.superuser) return `role ${row.role} is a superuser`
  if (row.bypass) return `role ${row.role} bypasses row-level security`
  if (row.owner) return `role ${row.role} owns the tables, so row-level security does not apply`
  if (!row.member) return `role ${row.role} is not a member of ${APP_ROLE}`
  return null
}

/**
 * The workspace's `seq` (D58): the last revision number handed out, `0` before the first. A
 * write holds the workspace row from taking its number until it commits, so every revision up
 * to this one is committed in the snapshot that reads it. Read it in the same transaction as
 * the rows it goes with: under `snapshot` anywhere in it, at READ COMMITTED before the rows.
 */
export async function workspaceSeq(
  trx: Transaction<Database>,
  workspaceId: string,
): Promise<number> {
  const row = await trx
    .selectFrom('workspace')
    .select(sql<number>`next_revision_seq - 1`.as('seq'))
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow()
  return row.seq
}
