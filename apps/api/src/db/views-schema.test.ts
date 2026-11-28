import { MAX_VIEW_BYTES, viewTreeBytes } from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { migrations } from './migrations/index.ts'
import { createTestDatabase } from './test-database.ts'

// Migration 0016 (#253, D76, D78): the view table and its row-level security, views-only
// folders, and the folder a hub opens on. Statements run as the table owner or as the API's
// role with the caller set the way the API sets it.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
})

afterEach(async () => {
  await appDb.destroy()
  await db.destroy()
  await drop()
})

const migrator = () =>
  new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

/**
 * w1 with hubs h1 (folders f1 and the views-only `home`) and h2 (folder g1), and h3, empty.
 * own: owner, hub admin of h1 and h3. ha: member, hub admin of h1. ed: member, editor of h1.
 * vw: member, viewer of h1. ag: agent with an editor grant on h1. out: member, no grant.
 */
async function fixtures(): Promise<void> {
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'One');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'Owner', 'owner'),
      ('w1', 'ha', 'user', 'Hub admin', 'member'),
      ('w1', 'ed', 'user', 'Editor', 'member'),
      ('w1', 'vw', 'user', 'Viewer', 'member'),
      ('w1', 'ag', 'agent', 'Agent', 'member'),
      ('w1', 'out', 'user', 'Outsider', 'member'),
      ('w1', 'ed2', 'user', 'Editor of h2', 'member');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'Hub 1', 'blue', 'A'),
      ('w1', 'h2', 'h2', NULL, 'Hub 2', 'red', 'B'),
      ('w1', 'h3', 'h3', NULL, 'Hub 3', 'green', 'C');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'f1', 'h1', 'h1', 'Backlog', 'blue', 'A'),
      ('w1', 'g1', 'h2', 'h2', 'Other', 'red', 'B');
    INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
      VALUES ('w1', 'i1', 'h1', 'f1', 1, '{}', 'own');
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role) VALUES
      ('w1', 'h1', 'own', 'hub_admin'), ('w1', 'h3', 'own', 'hub_admin'),
      ('w1', 'h1', 'ha', 'hub_admin'), ('w1', 'h1', 'ed', 'editor'), ('w1', 'h1', 'vw', 'viewer'),
      ('w1', 'h2', 'ed2', 'editor');
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, principal_kind, hub_role)
      VALUES ('w1', 'h1', 'ag', 'agent', 'editor');
  `.execute(db)
}

/** The views-only folder `home` in h1, as a hub admin creates it through the API. */
const createHome = () =>
  as('ha', (trx) =>
    sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix,
                            views_only)
        VALUES ('w1', 'home', 'h1', 'h1', 'Home', 'blue', 'A', true)`.execute(trx),
  )

async function as<T>(
  principalId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return appDb.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', 'w1', true),
                     set_config('app.principal_id', ${principalId}, true)`.execute(trx)
    return fn(trx)
  })
}

/** SQLSTATE of a statement run as `principalId` (or as the owner with null), or 'ok'. */
async function code(
  principalId: string | null,
  statement: (trx: Transaction<Database> | Kysely<Database>) => Promise<unknown>,
): Promise<string> {
  try {
    if (principalId === null) await db.transaction().execute((trx) => statement(trx))
    else await as(principalId, statement)
    return 'ok'
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

/** Rows a statement changed, run as `principalId`. */
const changed = (principalId: string, statement: ReturnType<typeof sql>) =>
  as(principalId, async (trx) => Number((await statement.execute(trx)).numAffectedRows ?? 0))

const insertView = (by: string, folderId = 'f1', hubId = 'h1', id = `v-${folderId}`) =>
  sql`INSERT INTO view (workspace_id, id, hub_id, folder_id, tree, updated_by)
      VALUES ('w1', ${id}, ${hubId}, ${folderId}, '{"schemaVersion":1}', ${by})`

const setOpensOn = (hub: string, folder: string | null) =>
  sql`UPDATE folder SET opens_on_folder_id = ${folder} WHERE workspace_id = 'w1' AND id = ${hub}`

const DENIED = '42501'

describe('0016_views up, down and up again', () => {
  const guard = async () => {
    const { rows } = await sql<{ def: string }>`
      SELECT pg_get_functiondef('folder_guard'::regproc) AS def
    `.execute(db)
    return rows[0]?.def
  }
  const folderUpdateGrant = async () => {
    const { rows } = await sql<{ column: string }>`
      SELECT column_name AS column FROM information_schema.column_privileges
      WHERE table_name = 'folder' AND grantee = 'sixteenbit_app' AND privilege_type = 'UPDATE'
      ORDER BY column_name
    `.execute(db)
    return rows.map((r) => r.column)
  }
  /** Editors still can't change the columns 0009 guards, but keep the item counters. */
  const editorStillGuarded = async () => {
    for (const set of [
      sql`name = 'x'`,
      sql`color = 'red'`,
      sql`version = version + 1`,
      sql`title_attribute_id = NULL, version = version + 1`,
      sql`parent_id = NULL`,
    ]) {
      expect(
        await code('ed', (trx) =>
          sql`UPDATE folder SET ${set} WHERE workspace_id = 'w1' AND id = 'f1'`.execute(trx),
        ),
      ).toBe(DENIED)
    }
    expect(
      await changed('ed', sql`UPDATE folder SET item_count = item_count WHERE id = 'f1'`),
    ).toBe(1)
  }

  it('applies to a database migrated to 0015 with data, restores 0009 on down, and applies again', async () => {
    expect((await migrator().migrateTo('0015_item_external_key')).error).toBeUndefined()
    await fixtures()
    const guard0009 = await guard()
    const grant0009 = await folderUpdateGrant()
    await editorStillGuarded()

    expect(await migrateToLatest(db)).toEqual([
      '0016_views',
      '0017_item_index_hub',
      '0018_external_login',
    ])
    expect(await guard()).not.toEqual(guard0009)
    expect(await folderUpdateGrant()).toEqual([...grant0009, 'opens_on_folder_id'].sort())
    const folders = await db
      .selectFrom('folder')
      .select(['id', 'views_only', 'opens_on_folder_id'])
      .orderBy('id')
      .execute()
    expect(folders.every((f) => !f.views_only && f.opens_on_folder_id === null)).toBe(true)
    await editorStillGuarded()
    await createHome()
    await as('ha', (trx) => insertView('ha').execute(trx))
    await as('ha', (trx) => setOpensOn('h1', 'home').execute(trx))

    expect((await migrator().migrateTo('0015_item_external_key')).error).toBeUndefined()
    expect(await guard()).toEqual(guard0009)
    expect(await folderUpdateGrant()).toEqual(grant0009)
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'folder' AND column_name IN ('views_only', 'opens_on_folder_id')
    `.execute(db)
    expect(rows[0]?.n).toBe(0)
    const gone = await sql<{ gone: boolean }>`SELECT to_regclass('view') IS NULL AS gone`.execute(
      db,
    )
    expect(gone.rows[0]?.gone).toBe(true)
    await editorStillGuarded()
    // The views-only folder is an ordinary folder again.
    await sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
              VALUES ('w1', 'i2', 'h1', 'home', 2, '{}', 'own')`.execute(db)
    await sql`DELETE FROM item WHERE id = 'i2'`.execute(db)

    expect(await migrateToLatest(db)).toEqual([
      '0016_views',
      '0017_item_index_hub',
      '0018_external_login',
    ])
    expect(await guard()).not.toEqual(guard0009)
    await editorStillGuarded()
    expect(await code('ed', (trx) => setOpensOn('h1', 'f1').execute(trx))).toBe(DENIED)
  })
})

describe('0016_views on the latest schema', () => {
  beforeEach(async () => {
    await migrateToLatest(db)
    await fixtures()
    await createHome()
  })

  describe('view', () => {
    it('is written by hub admins as themselves, and read with any grant on the hub', async () => {
      expect(await code('ha', (trx) => insertView('ha').execute(trx))).toBe('ok')
      expect(await code('own', (trx) => insertView('own', 'h1').execute(trx))).toBe('ok')
      // Not as someone else.
      expect(await code('ha', (trx) => insertView('own', 'home').execute(trx))).toBe(DENIED)
      expect(
        await changed(
          'ha',
          sql`UPDATE view SET tree = '{"a":1}', version = 2, updated_by = 'ha' WHERE id = 'v-f1'`,
        ),
      ).toBe(1)
      expect(
        await code('ha', (trx) =>
          sql`UPDATE view SET updated_by = 'own' WHERE id = 'v-f1'`.execute(trx),
        ),
      ).toBe(DENIED)
      const read = (p: string) =>
        as(p, (trx) => trx.selectFrom('view').select('id').orderBy('id').execute())
      for (const p of ['ha', 'ed', 'vw', 'ag', 'own']) {
        expect(await read(p), p).toEqual([{ id: 'v-f1' }, { id: 'v-h1' }])
      }
      expect(await read('out')).toEqual([])
      expect(await changed('ha', sql`DELETE FROM view WHERE id = 'v-h1'`)).toBe(1)
    })

    it('refuses editors, viewers and agents', async () => {
      await as('ha', (trx) => insertView('ha').execute(trx))
      for (const p of ['ed', 'vw', 'ag', 'out']) {
        expect(await code(p, (trx) => insertView(p, 'home').execute(trx)), p).toBe(DENIED)
        expect(await changed(p, sql`UPDATE view SET tree = '{}', updated_by = ${p}`), p).toBe(0)
        expect(await changed(p, sql`DELETE FROM view`), p).toBe(0)
      }
      expect(await db.selectFrom('view').select(['id', 'version']).execute()).toEqual([
        { id: 'v-f1', version: 1 },
      ])
    })

    it('never lets the API move a view to another workspace, hub or folder', async () => {
      await as('ha', (trx) => insertView('ha').execute(trx))
      for (const set of [sql`workspace_id = 'w2'`, sql`hub_id = 'h2'`, sql`folder_id = 'home'`]) {
        expect(await code('ha', (trx) => sql`UPDATE view SET ${set}`.execute(trx))).toBe(DENIED)
      }
    })

    it('holds its hub to its folder’s, one view per folder', async () => {
      expect(await code(null, (trx) => insertView('own', 'f1', 'h2').execute(trx))).toBe('23503')
      expect(await code(null, (trx) => insertView('own', 'g1', 'h1').execute(trx))).toBe('23503')
      await insertView('own').execute(db)
      expect(await code(null, (trx) => insertView('own', 'f1', 'h1', 'again').execute(trx))).toBe(
        '23505',
      )
    })

    it('stores a tree up to 128 KiB as core counts it, and no more', async () => {
      const base = { schemaVersion: 1, a: [1, 2], b: { é: null }, pad: '' }
      const fill = MAX_VIEW_BYTES - viewTreeBytes(base)
      const at = { ...base, pad: 'x'.repeat(fill) }
      expect(viewTreeBytes(at)).toBe(MAX_VIEW_BYTES)
      const put = (tree: object) =>
        code(null, (trx) =>
          sql`INSERT INTO view (workspace_id, id, hub_id, folder_id, tree, updated_by)
              VALUES ('w1', 'v', 'h1', 'f1', ${JSON.stringify(tree)}, 'own')`.execute(trx),
        )
      expect(await put({ ...base, pad: 'x'.repeat(fill + 1) })).toBe('23514')
      expect(await put(at)).toBe('ok')
      expect(await code(null, (trx) => sql`UPDATE view SET tree = '[]'`.execute(trx))).toBe('23514')
    })

    it('blocks deleting a folder with a stored view until the view is reset', async () => {
      await as('ha', (trx) => insertView('ha', 'home').execute(trx))
      expect(
        await code('ha', (trx) => sql`DELETE FROM folder WHERE id = 'home'`.execute(trx)),
      ).toBe('16B08')
      expect(
        await code(null, (trx) => sql`DELETE FROM folder WHERE id = 'home'`.execute(trx)),
      ).toBe('16B08')
      await as('ha', (trx) => sql`DELETE FROM view WHERE folder_id = 'home'`.execute(trx))
      expect(await changed('ha', sql`DELETE FROM folder WHERE id = 'home'`)).toBe(1)
    })

    it('goes with its hub through delete_hub', async () => {
      await as('own', (trx) => insertView('own', 'h3', 'h3').execute(trx))
      await as('own', (trx) => sql`SELECT delete_hub('h3', 0)`.execute(trx))
      expect(await db.selectFrom('view').select('id').execute()).toEqual([])
      expect(await db.selectFrom('folder').select('id').where('id', '=', 'h3').execute()).toEqual(
        [],
      )
    })
  })

  describe('views-only folders', () => {
    const item = (id: string, seq: number, folder: string) =>
      sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
          VALUES ('w1', ${id}, 'h1', ${folder}, ${seq}, '{}', 'ed')`

    it('refuse items, created or moved in, for every role', async () => {
      expect(await code('ed', (trx) => item('i2', 2, 'home').execute(trx))).toBe('16B07')
      expect(await code(null, (trx) => item('i2', 2, 'home').execute(trx))).toBe('16B07')
      expect(
        await code(null, (trx) =>
          sql`UPDATE item SET folder_id = 'home' WHERE id = 'i1'`.execute(trx),
        ),
      ).toBe('16B07')
      expect(await code('ed', (trx) => item('i3', 3, 'f1').execute(trx))).toBe('ok')
    })

    it('tell an editor of another hub nothing: the policy refuses first (42501)', async () => {
      // ed2 edits h2 only. Into h1's views-only folder, or an ordinary one, the answer is the same.
      const into = (folder: string, seq: number) =>
        code('ed2', (trx) =>
          sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
              VALUES ('w1', ${`x${String(seq)}`}, 'h1', ${folder}, ${seq}, '{}', 'ed2')`.execute(
            trx,
          ),
        )
      expect(await into('home', 20)).toBe(DENIED)
      expect(await into('f1', 21)).toBe(DENIED)
      // Claiming its own hub with h1's folder is the foreign key's 23503, as for any folder.
      expect(
        await code('ed2', (trx) =>
          sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
              VALUES ('w1', 'x22', 'h2', 'home', 22, '{}', 'ed2')`.execute(trx),
        ),
      ).toBe('23503')
    })

    it('stay views-only, and a hub row never is one', async () => {
      expect(
        await code(null, (trx) =>
          sql`UPDATE folder SET views_only = false WHERE id = 'home'`.execute(trx),
        ),
      ).toBe('23514')
      expect(
        await code(null, (trx) =>
          sql`UPDATE folder SET views_only = true WHERE id = 'f1'`.execute(trx),
        ),
      ).toBe('23514')
      // The API role has no grant on the column at all.
      expect(
        await code('ha', (trx) =>
          sql`UPDATE folder SET views_only = false WHERE id = 'home'`.execute(trx),
        ),
      ).toBe(DENIED)
      expect(
        await code(null, (trx) =>
          sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix, views_only)
              VALUES ('w1', 'h4', 'h4', NULL, 'Hub 4', 'blue', 'D', true)`.execute(trx),
        ),
      ).toBe('23514')
    })
  })

  describe('opens_on_folder_id', () => {
    it('is set by hub admins, never by editors or agents', async () => {
      expect(await changed('ha', setOpensOn('h1', 'home'))).toBe(1)
      expect(await code('ed', (trx) => setOpensOn('h1', 'f1').execute(trx))).toBe(DENIED)
      expect(await code('ag', (trx) => setOpensOn('h1', null).execute(trx))).toBe(DENIED)
      expect(await changed('vw', setOpensOn('h1', null))).toBe(0)
      const hub = await db
        .selectFrom('folder')
        .select('opens_on_folder_id')
        .where('id', '=', 'h1')
        .executeTakeFirst()
      expect(hub?.opens_on_folder_id).toBe('home')
    })

    it('names a folder of the same hub, other than the hub, on hub rows only', async () => {
      expect(await code(null, (trx) => setOpensOn('h1', 'g1').execute(trx))).toBe('23503')
      expect(await code(null, (trx) => setOpensOn('h1', 'nope').execute(trx))).toBe('23503')
      expect(await code(null, (trx) => setOpensOn('f1', 'home').execute(trx))).toBe('23514')
      expect(await code(null, (trx) => setOpensOn('h1', 'h1').execute(trx))).toBe('23514')
    })

    it('is cleared when that folder is deleted', async () => {
      await as('ha', (trx) => setOpensOn('h1', 'home').execute(trx))
      expect(await changed('ha', sql`DELETE FROM folder WHERE id = 'home'`)).toBe(1)
      const hub = await db
        .selectFrom('folder')
        .select(['opens_on_folder_id', 'version'])
        .where('id', '=', 'h1')
        .executeTakeFirst()
      expect(hub).toEqual({ opens_on_folder_id: null, version: 0 })
    })
  })
})
