import { sql, type Kysely, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { createTestDatabase } from './test-database.ts'

// A deleted attribute's ID is never reused (#133, migration 0011): attribute_tombstone records
// it, attribute_id_check refuses it. Raw SQL as the owner, and as the API's role with the
// caller set the way the API sets it.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  // w1: hubs h1 (own and ha hub admins) and h2 (own only). w2 reuses the attribute IDs.
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'One'), ('w2', 'Two');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'Owner', 'owner'),
      ('w1', 'ha', 'user', 'Hub admin', 'member'),
      ('w2', 'own', 'user', 'Owner', 'owner');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'Hub 1', 'blue', 'A'),
      ('w1', 'h2', 'h2', NULL, 'Hub 2', 'red', 'B'),
      ('w2', 'h1', 'h1', NULL, 'Other', 'green', 'C');
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role) VALUES
      ('w1', 'h1', 'own', 'hub_admin'),
      ('w1', 'h1', 'ha', 'hub_admin'),
      ('w1', 'h2', 'own', 'hub_admin'),
      ('w2', 'h1', 'own', 'hub_admin');
  `.execute(db)
}, 60_000)

afterAll(async () => {
  await appDb.destroy()
  await db.destroy()
  await drop()
})

type Scope = { workspaceId: string; principalId: string }
const w1 = (principalId: string): Scope => ({ workspaceId: 'w1', principalId })

/** Runs `fn` as the API's role with the caller set, and commits. */
async function commit<T>(scope: Scope, fn: (trx: Transaction<Database>) => Promise<T>) {
  return appDb.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true),
                     set_config('app.principal_id', ${scope.principalId}, true)`.execute(trx)
    return fn(trx)
  })
}

/** The SQLSTATE `p` fails with, or 'ok'. */
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (error: unknown) => String((error as { code?: unknown }).code),
  )

const UNIQUE = '23505'
const DENIED = '42501'

let next = 0
/** A fresh attribute ID, so the tests don't share tombstones. */
const freshId = () => `a${String(++next)}`

/** As the API creates an attribute (#112): ON CONFLICT DO NOTHING on the primary key. */
const insert =
  (id: string, hub = 'h1', type = 'text', workspace = 'w1') =>
  (trx: Transaction<Database> | Kysely<Database>) =>
    sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type)
        VALUES (${workspace}, ${id}, ${hub}, 'Name', ${type})
        ON CONFLICT (workspace_id, id) DO NOTHING`.execute(trx)

const remove = (id: string) => (trx: Transaction<Database> | Kysely<Database>) =>
  sql`DELETE FROM attribute WHERE workspace_id = 'w1' AND id = ${id}`.execute(trx)

const tombstone = (id: string, workspace = 'w1') =>
  db
    .selectFrom('deleted_attribute')
    .select(['hub_id', 'deleted_by'])
    .where('workspace_id', '=', workspace)
    .where('id', '=', id)
    .executeTakeFirst()

describe('deleted attribute IDs', () => {
  it('records the ID, the hub and the caller when the API deletes an attribute', async () => {
    const id = freshId()
    await commit(w1('ha'), insert(id))
    expect(await tombstone(id)).toBeUndefined()
    await commit(w1('ha'), remove(id))
    expect(await tombstone(id)).toEqual({ hub_id: 'h1', deleted_by: 'ha' })
  })

  it('refuses the ID afterwards, in any hub and with any type, for the API and the owner', async () => {
    const id = freshId()
    await commit(w1('own'), insert(id))
    await commit(w1('own'), remove(id))

    expect(await outcome(commit(w1('own'), insert(id)))).toBe(UNIQUE)
    expect(await outcome(commit(w1('own'), insert(id, 'h2', 'number')))).toBe(UNIQUE)
    expect(await outcome(insert(id, 'h1', 'number')(db))).toBe(UNIQUE)
    // Another ID, and the same ID in another workspace, are fine.
    expect(await outcome(commit(w1('own'), insert(freshId())))).toBe('ok')
    expect(
      await outcome(
        commit({ workspaceId: 'w2', principalId: 'own' }, insert(id, 'h1', 'text', 'w2')),
      ),
    ).toBe('ok')
  })

  it('records a delete outside the API with no caller', async () => {
    const id = freshId()
    await insert(id)(db)
    await remove(id)(db)
    expect(await tombstone(id)).toEqual({ hub_id: 'h1', deleted_by: null })
    expect(await outcome(insert(id)(db))).toBe(UNIQUE)
  })

  it('records the attributes delete_hub deletes', async () => {
    await sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
              VALUES ('w1', 'h3', 'h3', NULL, 'Hub 3', 'blue', 'D');
              INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role)
              VALUES ('w1', 'h3', 'own', 'hub_admin')`.execute(db)
    const id = freshId()
    await commit(w1('own'), insert(id, 'h3'))
    await commit(w1('own'), (trx) => sql`SELECT delete_hub('h3', 0)`.execute(trx))
    expect(await tombstone(id)).toEqual({ hub_id: 'h3', deleted_by: 'own' })
    expect(await outcome(commit(w1('own'), insert(id, 'h1')))).toBe(UNIQUE)
  })

  it('keeps the tombstones from the API role', async () => {
    expect(
      await outcome(commit(w1('own'), (trx) => sql`SELECT 1 FROM deleted_attribute`.execute(trx))),
    ).toBe(DENIED)
    expect(
      await outcome(
        commit(w1('own'), (trx) =>
          sql`DELETE FROM deleted_attribute WHERE workspace_id = 'w1'`.execute(trx),
        ),
      ),
    ).toBe(DENIED)
    const { rows } = await sql<{ fn: string; allowed: boolean }>`
      SELECT fn, has_function_privilege('sixteenbit_app', fn, 'EXECUTE') AS allowed
      FROM unnest(ARRAY['attribute_id_check()', 'attribute_tombstone()']) AS fn
    `.execute(db)
    expect(rows.every((r) => !r.allowed)).toBe(true)
  })

  // As #126 did for hubs: the insert must not slip in between the delete and its tombstone.
  for (const as of ['the owner', 'the API role'] as const) {
    it(`never lets an insert by ${as} racing a delete take the deleted ID`, async () => {
      const id = freshId()
      await commit(w1('own'), insert(id))
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      let deleted!: () => void
      const deletedUncommitted = new Promise<void>((resolve) => (deleted = resolve))

      const deleting = commit(w1('ha'), async (trx) => {
        await remove(id)(trx)
        deleted()
        await held
      })
      await deletedUncommitted
      const reuse = outcome(
        as === 'the owner' ? insert(id, 'h2', 'number')(db) : commit(w1('own'), insert(id, 'h2')),
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      release()
      await deleting
      expect(await reuse).toBe(UNIQUE)
      const row = await db
        .selectFrom('attribute')
        .select('id')
        .where('workspace_id', '=', 'w1')
        .where('id', '=', id)
        .executeTakeFirst()
      expect(row).toBeUndefined()
    })
  }

  it('lets an insert racing a delete that rolls back find the ID still taken', async () => {
    const id = freshId()
    await commit(w1('own'), insert(id))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let deleted!: () => void
    const deletedUncommitted = new Promise<void>((resolve) => (deleted = resolve))

    const deleting = outcome(
      commit(w1('ha'), async (trx) => {
        await remove(id)(trx)
        deleted()
        await held
        throw new Error('roll back')
      }),
    )
    await deletedUncommitted
    // ON CONFLICT DO NOTHING: the row is back, so nothing is inserted and nothing raised.
    const reuse = commit(w1('own'), (trx) => insert(id, 'h2')(trx))
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    expect(await deleting).toBe('undefined')
    expect((await reuse).numAffectedRows).toBe(0n)
    expect(await tombstone(id)).toBeUndefined()
  })
})
