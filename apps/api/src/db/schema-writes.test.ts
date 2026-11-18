import type { HubRole } from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { createTestDatabase } from './test-database.ts'

// Schema writes (#111, migration 0009): the data rules every role is held to, the row-level
// security that keeps schema writes to hub admins, and delete_hub() (D52). Raw SQL as the
// owner, and as the API's role with the caller set the way the API sets it.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await fixtures()
}, 60_000)

afterAll(async () => {
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * w1: hub h1 (folders f1 > f2, attributes t text, n number, rel relation into h1) and hub h2.
 * Grants on h1: own and ha hub admin, mem editor, vw hub admin (a viewer, so effectively a
 * viewer), ag an editor agent. own also holds h2. adm, own2 and out hold nothing.
 * w2 reuses the IDs h1 and ha, so a policy that forgot workspace_id would show.
 */
async function fixtures(): Promise<void> {
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'One'), ('w2', 'Two');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'Owner', 'owner'),
      ('w1', 'own2', 'user', 'Owner 2', 'owner'),
      ('w1', 'adm', 'user', 'Admin', 'admin'),
      ('w1', 'mem', 'user', 'Member', 'member'),
      ('w1', 'ha', 'user', 'Hub admin', 'member'),
      ('w1', 'vw', 'user', 'Viewer', 'viewer'),
      ('w1', 'out', 'user', 'Outsider', 'member'),
      ('w1', 'ag', 'agent', 'Agent', 'member'),
      ('w2', 'ha', 'user', 'Hub admin', 'owner');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'Hub 1', 'blue', 'A'),
      ('w1', 'h2', 'h2', NULL, 'Hub 2', 'red', 'B'),
      ('w2', 'h1', 'h1', NULL, 'Other', 'green', 'C');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'f1', 'h1', 'h1', 'Folder 1', 'blue', 'F'),
      ('w1', 'f2', 'h1', 'f1', 'Folder 2', 'blue', 'G');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, config) VALUES
      ('w1', 't', 'h1', 'Title', 'text', '{}'),
      ('w1', 'n', 'h1', 'Points', 'number', '{}'),
      ('w1', 'rel', 'h1', 'Links', 'relation', '{"targetHubId":"h1","crossHub":false}'),
      ('w1', 't2', 'h2', 'Title', 'text', '{}'),
      ('w2', 't', 'h1', 'Title', 'text', '{}');
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position) VALUES
      ('w1', 'h1', 'f1', 't', 0), ('w1', 'h1', 'f1', 'n', 1);
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role) VALUES
      ('w1', 'h1', 'own', 'hub_admin'),
      ('w1', 'h1', 'ha', 'hub_admin'),
      ('w1', 'h1', 'mem', 'editor'),
      ('w1', 'h1', 'vw', 'hub_admin'),
      ('w1', 'h2', 'own', 'hub_admin'),
      ('w2', 'h1', 'ha', 'hub_admin');
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, principal_kind, hub_role)
      VALUES ('w1', 'h1', 'ag', 'agent', 'editor');
  `.execute(db)
}

type Scope = { workspaceId: string; principalId: string }
const w1 = (principalId: string): Scope => ({ workspaceId: 'w1', principalId })

class Rollback extends Error {}

/**
 * Runs `fn` as the API's role with the caller set, then rolls back. Returns 'ok', the SQLSTATE
 * of the error, or 'no_rows' when an UPDATE or DELETE matched nothing (RLS hid the row).
 */
async function attempt(
  scope: Scope,
  fn: (trx: Transaction<Database>) => Promise<{ numAffectedRows?: bigint } | undefined>,
): Promise<string> {
  try {
    await appDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true),
                       set_config('app.principal_id', ${scope.principalId}, true)`.execute(trx)
      const result = await fn(trx)
      if (result && result.numAffectedRows === 0n) {
        throw Object.assign(new Error('no rows'), { code: 'no_rows' })
      }
      throw new Rollback()
    })
    return 'unreachable'
  } catch (error) {
    if (error instanceof Rollback) return 'ok'
    return String((error as { code?: unknown }).code)
  }
}

/** Like attempt, but commits. */
async function commit(scope: Scope, fn: (trx: Transaction<Database>) => Promise<unknown>) {
  return appDb.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true),
                     set_config('app.principal_id', ${scope.principalId}, true)`.execute(trx)
    return fn(trx)
  })
}

const DENIED = '42501' // insufficient privilege, an RLS WITH CHECK, or a guard trigger
const CHECK = '23514'
const FK = '23503'
const UNIQUE = '23505'

/** Every principal of w1 but the two hub admins of h1, who may change its schema. */
const LOWER = ['mem', 'vw', 'ag', 'out', 'adm', 'own2'] as const

describe('schema privileges', () => {
  it('grants USAGE on the public schema explicitly, so a hardened schema still works', async () => {
    const { rows } = await sql<{ explicit: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname = 'public' AND a.grantee = 'sixteenbit_app'::regrole
          AND a.privilege_type = 'USAGE') AS explicit
    `.execute(db)
    expect(rows[0]?.explicit).toBe(true)

    // Schemas are per database: this hardens only the test database.
    await sql`REVOKE ALL ON SCHEMA public FROM PUBLIC`.execute(db)
    try {
      expect(await attempt(w1('own'), (trx) => sql`SELECT 1 FROM folder`.execute(trx))).toBe('ok')
    } finally {
      await sql`GRANT USAGE ON SCHEMA public TO PUBLIC`.execute(db)
    }
  })

  it('lets only the API role execute delete_hub', async () => {
    const { rows } = await sql<{ app: boolean; pub: boolean }>`
      SELECT has_function_privilege('sixteenbit_app', 'delete_hub(text)', 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                     WHERE p.proname = 'delete_hub' AND a.grantee = 0) AS pub
    `.execute(db)
    expect(rows[0]).toEqual({ app: true, pub: false })
  })

  it('never lets the API change an attribute type, hub or indexing (D51)', async () => {
    for (const set of [sql`type = 'number'`, sql`hub_id = 'h2'`, sql`indexed = true`]) {
      expect(
        await attempt(w1('ha'), (trx) =>
          sql`UPDATE attribute SET ${set} WHERE workspace_id = 'w1' AND id = 't'`.execute(trx),
        ),
      ).toBe(DENIED)
    }
  })

  it('starts every attribute at version 0', async () => {
    const rows = await db.selectFrom('attribute').select('version').distinct().execute()
    expect(rows).toEqual([{ version: 0 }])
  })
})

describe('title attribute (D50)', () => {
  const setTitle = (folder: string, attribute: string | null) =>
    sql`UPDATE folder SET title_attribute_id = ${attribute}
        WHERE workspace_id = 'w1' AND id = ${folder}`.execute(db)

  it('accepts a text attribute of the hub on the hub row', async () => {
    await setTitle('h1', 't')
    await setTitle('h1', null)
  })

  it('refuses a subfolder, another hub’s attribute, a missing one, and a non-text one', async () => {
    await expect(setTitle('f1', 't')).rejects.toMatchObject({ code: CHECK })
    // folder_title_check runs before the foreign key, so these are its check violations.
    await expect(setTitle('h1', 't2')).rejects.toMatchObject({ code: CHECK })
    await expect(setTitle('h1', 'nope')).rejects.toMatchObject({ code: CHECK })
    await expect(setTitle('h1', 'n')).rejects.toMatchObject({ code: CHECK })
  })

  it('is cleared when its attribute is deleted, and keeps its attribute text meanwhile', async () => {
    await sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type)
              VALUES ('w1', 'tmp', 'h1', 'Temp', 'text')`.execute(db)
    await setTitle('h1', 'tmp')
    await expect(
      sql`UPDATE attribute SET type = 'number' WHERE workspace_id = 'w1' AND id = 'tmp'`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: CHECK })

    // As the API would: a hub admin deletes the attribute, the hub row's title goes with it.
    await commit(w1('ha'), (trx) =>
      sql`DELETE FROM attribute WHERE workspace_id = 'w1' AND id = 'tmp'`.execute(trx),
    )
    const hub = await db
      .selectFrom('folder')
      .select('title_attribute_id')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'h1')
      .executeTakeFirstOrThrow()
    expect(hub.title_attribute_id).toBeNull()
  })

  it('is set by a hub admin only', async () => {
    const set = (trx: Transaction<Database>) =>
      sql`UPDATE folder SET title_attribute_id = 't', version = version + 1
          WHERE workspace_id = 'w1' AND id = 'h1'`.execute(trx)
    expect(await attempt(w1('ha'), set)).toBe('ok')
    expect(await attempt(w1('own'), set)).toBe('ok')
    // Editors pass folder_update (item counters) but not folder_guard.
    expect(await attempt(w1('mem'), set)).toBe(DENIED)
    expect(await attempt(w1('ag'), set)).toBe(DENIED)
    for (const p of ['vw', 'out', 'adm', 'own2']) expect(await attempt(w1(p), set)).toBe('no_rows')
  })
})

describe('folders', () => {
  const create = (trx: Transaction<Database>, parent = 'h1', hub = 'h1') =>
    sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
        VALUES ('w1', 'new', ${hub}, ${parent}, 'New', 'blue', 'N')`.execute(trx)

  it('are created by a hub admin, under a parent in the hub', async () => {
    expect(await attempt(w1('ha'), (trx) => create(trx))).toBe('ok')
    expect(await attempt(w1('ha'), (trx) => create(trx, 'f2'))).toBe('ok')
    for (const p of LOWER) expect(await attempt(w1(p), (trx) => create(trx))).toBe(DENIED)
    // Not in a hub they don't administer, and a hub row only through folder_create_hub.
    expect(await attempt(w1('ha'), (trx) => create(trx, 'h2', 'h2'))).toBe(DENIED)
    expect(
      await attempt(w1('ha'), (trx) =>
        sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
            VALUES ('w1', 'hx', 'hx', NULL, 'Hub', 'blue', 'X')`.execute(trx),
      ),
    ).toBe(DENIED)
  })

  it('are renamed, recoloured and moved by a hub admin only', async () => {
    const rename = (trx: Transaction<Database>) =>
      sql`UPDATE folder SET name = 'Renamed', color = 'red', version = version + 1
          WHERE workspace_id = 'w1' AND id = 'f2'`.execute(trx)
    const move = (trx: Transaction<Database>) =>
      sql`UPDATE folder SET parent_id = 'h1' WHERE workspace_id = 'w1' AND id = 'f2'`.execute(trx)
    for (const change of [rename, move]) {
      expect(await attempt(w1('ha'), change)).toBe('ok')
      expect(await attempt(w1('mem'), change)).toBe(DENIED)
      expect(await attempt(w1('ag'), change)).toBe(DENIED)
      for (const p of ['vw', 'out', 'adm', 'own2']) {
        expect(await attempt(w1(p), change)).toBe('no_rows')
      }
    }
    // Editors still keep the item counters.
    expect(
      await attempt(w1('mem'), (trx) =>
        sql`UPDATE folder SET item_count = item_count + 1
            WHERE workspace_id = 'w1' AND id = 'f2'`.execute(trx),
      ),
    ).toBe('ok')
  })

  it('never move under themselves or a descendant, or into another hub', async () => {
    const moveTo = (id: string, parent: string) => (trx: Transaction<Database>) =>
      sql`UPDATE folder SET parent_id = ${parent}
          WHERE workspace_id = 'w1' AND id = ${id}`.execute(trx)
    expect(await attempt(w1('ha'), moveTo('f1', 'f1'))).toBe(CHECK)
    expect(await attempt(w1('ha'), moveTo('f1', 'f2'))).toBe(CHECK)
    expect(await attempt(w1('own'), moveTo('f1', 'h2'))).toBe(FK)
    // The owner of the tables is held to it too.
    await expect(
      sql`UPDATE folder SET parent_id = 'f2' WHERE workspace_id = 'w1' AND id = 'f1'`.execute(db),
    ).rejects.toMatchObject({ code: CHECK })
  })

  it('are deleted by a hub admin when empty; a hub row never is', async () => {
    const del = (id: string) => (trx: Transaction<Database>) =>
      sql`DELETE FROM folder WHERE workspace_id = 'w1' AND id = ${id}`.execute(trx)
    expect(await attempt(w1('ha'), del('f2'))).toBe('ok')
    for (const p of LOWER) expect(await attempt(w1(p), del('f2'))).toBe('no_rows')
    // f1 still has f2 and attributes; the hub row needs delete_hub().
    expect(await attempt(w1('ha'), del('f1'))).toBe(FK)
    expect(await attempt(w1('ha'), del('h1'))).toBe('no_rows')
    expect(await attempt(w1('own'), del('h2'))).toBe('no_rows')
  })
})

describe('attributes', () => {
  const create =
    (config: object, type = 'relation') =>
    (trx: Transaction<Database>) =>
      sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type, config)
        VALUES ('w1', 'new', 'h1', 'New', ${type}, ${JSON.stringify(config)})`.execute(trx)

  it('are created by a hub admin only', async () => {
    expect(await attempt(w1('ha'), create({}, 'text'))).toBe('ok')
    for (const p of LOWER) expect(await attempt(w1(p), create({}, 'text'))).toBe(DENIED)
    // Same IDs, other workspace: ha is hub admin of w2's h1, not of w1's.
    expect(
      await attempt({ workspaceId: 'w1', principalId: 'ha' }, (trx) =>
        sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type)
            VALUES ('w2', 'new', 'h1', 'New', 'text')`.execute(trx),
      ),
    ).toBe(DENIED)
  })

  it('target another hub only with crossHub and at least viewer access on it (D11)', async () => {
    expect(await attempt(w1('ha'), create({ targetHubId: 'h1', crossHub: false }))).toBe('ok')
    // ha holds no grant on h2; own does.
    expect(await attempt(w1('ha'), create({ targetHubId: 'h2', crossHub: true }))).toBe(DENIED)
    expect(await attempt(w1('own'), create({ targetHubId: 'h2', crossHub: true }))).toBe('ok')
    expect(await attempt(w1('own'), create({ targetHubId: 'h2', crossHub: false }))).toBe(DENIED)
    expect(await attempt(w1('own'), create({ targetHubId: 'nope', crossHub: true }))).toBe(FK)
    expect(await attempt(w1('own'), create({ crossHub: true }))).toBe(DENIED)
  })

  it('are renamed and given new options by a hub admin; type and target stay (D51)', async () => {
    const rename = (trx: Transaction<Database>) =>
      sql`UPDATE attribute SET name = 'Renamed', version = version + 1
          WHERE workspace_id = 'w1' AND id = 'n'`.execute(trx)
    expect(await attempt(w1('ha'), rename)).toBe('ok')
    for (const p of LOWER) expect(await attempt(w1(p), rename)).toBe('no_rows')

    const retarget = (config: object) => (trx: Transaction<Database>) =>
      sql`UPDATE attribute SET config = ${JSON.stringify(config)}
          WHERE workspace_id = 'w1' AND id = 'rel'`.execute(trx)
    expect(await attempt(w1('own'), retarget({ targetHubId: 'h1', crossHub: false }))).toBe('ok')
    expect(
      await attempt(w1('own'), retarget({ targetHubId: 'h1', crossHub: false, multiple: false })),
    ).toBe('ok')
    expect(await attempt(w1('own'), retarget({ targetHubId: 'h2', crossHub: true }))).toBe(DENIED)
    expect(await attempt(w1('own'), retarget({ targetHubId: 'h1', crossHub: true }))).toBe(DENIED)
  })

  it('are deleted by a hub admin only', async () => {
    const del = (trx: Transaction<Database>) =>
      sql`DELETE FROM attribute WHERE workspace_id = 'w1' AND id = 'rel'`.execute(trx)
    expect(await attempt(w1('ha'), del)).toBe('ok')
    for (const p of LOWER) expect(await attempt(w1(p), del)).toBe('no_rows')
    // Attached to a folder: the API detaches it first.
    expect(
      await attempt(w1('ha'), (trx) =>
        sql`DELETE FROM attribute WHERE workspace_id = 'w1' AND id = 't'`.execute(trx),
      ),
    ).toBe(FK)
  })
})

describe('folder attributes', () => {
  const changes = {
    attach: (trx: Transaction<Database>) =>
      sql`INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
          VALUES ('w1', 'h1', 'f2', 't', 0)`.execute(trx),
    reorder: (trx: Transaction<Database>) =>
      sql`UPDATE folder_attribute SET position = 5, required = true
          WHERE workspace_id = 'w1' AND folder_id = 'f1' AND attribute_id = 'n'`.execute(trx),
    detach: (trx: Transaction<Database>) =>
      sql`DELETE FROM folder_attribute
          WHERE workspace_id = 'w1' AND folder_id = 'f1' AND attribute_id = 'n'`.execute(trx),
  }

  it('are changed by a hub admin only', async () => {
    for (const change of Object.values(changes)) {
      expect(await attempt(w1('ha'), change)).toBe('ok')
      for (const p of LOWER) expect(await attempt(w1(p), change)).toMatch(/^(42501|no_rows)$/)
    }
    expect(await attempt(w1('mem'), changes.attach)).toBe(DENIED)
    expect(await attempt(w1('mem'), changes.reorder)).toBe('no_rows')
  })

  it('never use an attribute of another hub (D10)', async () => {
    expect(
      await attempt(w1('own'), (trx) =>
        sql`INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
            VALUES ('w1', 'h1', 'f2', 't2', 0)`.execute(trx),
      ),
    ).toBe(FK)
  })
})

describe('delete_hub (D52)', () => {
  let next = 0

  /**
   * An empty hub with a title attribute shown on it, a relation into itself, an agent key, and
   * the given people's grants. Made as the owner of the tables.
   */
  async function hub(grants: Record<string, HubRole>): Promise<string> {
    const id = `d${String(++next)}`
    const agent = `${id}-agent`
    // One statement each: parameters can't go into a multi-statement query.
    const statements = [
      sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
          VALUES ('w1', ${id}, ${id}, NULL, ${`Hub ${id}`}, 'blue', 'D')`,
      sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type, config) VALUES
          ('w1', ${`${id}-t`}, ${id}, 'Title', 'text', '{}'),
          ('w1', ${`${id}-r`}, ${id}, 'Self', 'relation',
           ${JSON.stringify({ targetHubId: id, crossHub: false })})`,
      sql`INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
          VALUES ('w1', ${id}, ${id}, ${`${id}-t`}, 0)`,
      sql`UPDATE folder SET title_attribute_id = ${`${id}-t`}
          WHERE workspace_id = 'w1' AND id = ${id}`,
      sql`INSERT INTO principal (workspace_id, id, kind, name, workspace_role)
          VALUES ('w1', ${agent}, 'agent', 'Bot', 'member')`,
      sql`INSERT INTO hub_grant (workspace_id, hub_id, principal_id, principal_kind, hub_role)
          VALUES ('w1', ${id}, ${agent}, 'agent', 'viewer')`,
      sql`INSERT INTO agent_key (workspace_id, principal_id, secret_hash, created_by)
          VALUES ('w1', ${agent}, ${`hash-${id}`}, 'own')`,
    ]
    for (const statement of statements) await statement.execute(db)
    for (const [principal, role] of Object.entries(grants)) {
      await db
        .insertInto('hub_grant')
        .values({ workspace_id: 'w1', hub_id: id, principal_id: principal, hub_role: role })
        .execute()
    }
    return id
  }

  const deleteHub = (id: string) => (trx: Transaction<Database>) =>
    sql`SELECT delete_hub(${id})`.execute(trx).then(() => undefined)

  const exists = async (id: string) =>
    (await db
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', id)
      .executeTakeFirst()) !== undefined

  it('deletes an empty hub for an owner with a grant: keys revoked, grants and schema gone, all logged', async () => {
    const id = await hub({ own: 'hub_admin', mem: 'editor' })
    const before = await db
      .selectFrom('workspace')
      .select('next_access_seq')
      .where('id', '=', 'w1')
      .executeTakeFirstOrThrow()

    await commit(w1('own'), deleteHub(id))

    expect(await exists(id)).toBe(false)
    expect(
      await db.selectFrom('attribute').select('id').where('hub_id', '=', id).execute(),
    ).toEqual([])
    expect(
      await db.selectFrom('hub_grant').select('principal_id').where('hub_id', '=', id).execute(),
    ).toEqual([])
    const key = await db
      .selectFrom('agent_key')
      .select('revoked_at')
      .where('workspace_id', '=', 'w1')
      .where('principal_id', '=', `${id}-agent`)
      .executeTakeFirstOrThrow()
    expect(key.revoked_at).not.toBeNull()
    expect(
      await db
        .selectFrom('deleted_hub')
        .select(['id', 'deleted_by'])
        .where('id', '=', id)
        .execute(),
    ).toEqual([{ id, deleted_by: 'own' }])

    const log = await db
      .selectFrom('access_log')
      .select(['seq', 'actor', 'action', 'target', 'detail'])
      .where('workspace_id', '=', 'w1')
      .where('seq', '>=', before.next_access_seq)
      .orderBy('seq')
      .execute()
    const s = before.next_access_seq
    expect(log).toEqual([
      { seq: s, actor: 'own', action: 'key.revoke', target: `${id}-agent`, detail: { hubId: id } },
      {
        seq: s + 1,
        actor: 'own',
        action: 'grant.revoke',
        target: `${id}-agent`,
        detail: { hubId: id, previous: 'viewer' },
      },
      {
        seq: s + 2,
        actor: 'own',
        action: 'grant.revoke',
        target: 'mem',
        detail: { hubId: id, previous: 'editor' },
      },
      {
        seq: s + 3,
        actor: 'own',
        action: 'grant.revoke',
        target: 'own',
        detail: { hubId: id, previous: 'hub_admin' },
      },
      {
        seq: s + 4,
        actor: 'own',
        action: 'hub.delete',
        target: id,
        detail: { hubId: id, name: `Hub ${id}` },
      },
    ])
    const after = await db
      .selectFrom('workspace')
      .select('next_access_seq')
      .where('id', '=', 'w1')
      .executeTakeFirstOrThrow()
    expect(after.next_access_seq).toBe(s + 5)
  })

  it('deletes for an admin with a grant while no owner holds one', async () => {
    const id = await hub({ adm: 'viewer' })
    expect(await attempt(w1('adm'), deleteHub(id))).toBe('ok')
  })

  it('refuses an admin while an owner holds a grant (footnote 1)', async () => {
    const id = await hub({ adm: 'hub_admin', own2: 'viewer' })
    expect(await attempt(w1('adm'), deleteHub(id))).toBe(DENIED)
    expect(await attempt(w1('own2'), deleteHub(id))).toBe('ok')
  })

  it('refuses an owner or admin without a grant, and everyone below them', async () => {
    const id = await hub({ ha: 'hub_admin', mem: 'editor', vw: 'viewer' })
    expect(await attempt(w1('own'), deleteHub(id))).toBe(DENIED)
    expect(await attempt(w1('adm'), deleteHub(id))).toBe(DENIED)
    for (const p of ['ha', 'mem', 'vw', `${id}-agent`]) {
      expect(await attempt(w1(p), deleteHub(id))).toBe(DENIED)
    }
    // No grant and not an owner or admin: the hub is hidden.
    expect(await attempt(w1('out'), deleteHub(id))).toBe('16B03')
    expect(await exists(id)).toBe(true)
  })

  it('answers not found for a missing hub, a subfolder, another workspace’s hub, and a non-member', async () => {
    expect(await attempt(w1('own'), deleteHub('nope'))).toBe('16B03')
    expect(await attempt(w1('own'), deleteHub('f1'))).toBe('16B03')
    expect(await attempt({ workspaceId: 'w2', principalId: 'own' }, deleteHub('h1'))).toBe('16B03')
    expect(await attempt({ workspaceId: 'w2', principalId: 'ha' }, deleteHub('h2'))).toBe('16B03')
  })

  it('refuses a hub with a folder or an item', async () => {
    const withFolder = await hub({ own: 'hub_admin' })
    await sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
              VALUES ('w1', ${`${withFolder}-f`}, ${withFolder}, ${withFolder}, 'F', 'blue', 'F')`.execute(
      db,
    )
    expect(await attempt(w1('own'), deleteHub(withFolder))).toBe('16B04')

    const withItem = await hub({ own: 'hub_admin' })
    await sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, updated_by)
              VALUES ('w1', ${`${withItem}-i`}, ${withItem}, ${withItem}, 1, 'own')`.execute(db)
    expect(await attempt(w1('own'), deleteHub(withItem))).toBe('16B04')
  })

  it('refuses a hub that a relation in another hub targets', async () => {
    const id = await hub({ own: 'hub_admin' })
    await sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type, config)
              VALUES ('w1', ${`${id}-in`}, 'h2', 'Into', 'relation',
                      ${JSON.stringify({ targetHubId: id, crossHub: true })})`.execute(db)
    expect(await attempt(w1('own'), deleteHub(id))).toBe('16B05')
    await sql`DELETE FROM attribute WHERE workspace_id = 'w1' AND id = ${`${id}-in`}`.execute(db)
    expect(await attempt(w1('own'), deleteHub(id))).toBe('ok')
  })

  it('keeps the history of deleted items, readable by no one, and never reuses the hub ID', async () => {
    const id = await hub({ own: 'hub_admin' })
    await sql`
      INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor) VALUES
        ('w1', 1000, ${`${id}-gone`}, ${id}, 1, ${JSON.stringify({ op: 'create', folderId: id })}, 'own'),
        ('w1', 1001, ${`${id}-gone`}, ${id}, 2, '{"op":"delete"}', 'own')
    `.execute(db)
    await commit(w1('own'), deleteHub(id))

    expect(
      await db.selectFrom('revision').select('seq').where('hub_id', '=', id).execute(),
    ).toHaveLength(2)
    expect(
      await commit(w1('own'), (trx) =>
        trx.selectFrom('revision').select('seq').where('hub_id', '=', id).execute(),
      ),
    ).toEqual([])

    const recreate = (trx: Transaction<Database> | Kysely<Database>) =>
      sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
          VALUES ('w1', ${id}, ${id}, NULL, 'Again', 'blue', 'D')`.execute(trx)
    expect(await attempt(w1('own'), recreate)).toBe(UNIQUE)
    await expect(recreate(db)).rejects.toMatchObject({ code: UNIQUE })
    // The API role can't read the tombstones.
    expect(await attempt(w1('own'), (trx) => sql`SELECT 1 FROM deleted_hub`.execute(trx))).toBe(
      DENIED,
    )
  })

  it('waits for an item write holding its grant, then sees the item', async () => {
    const id = await hub({ own: 'hub_admin', mem: 'editor' })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const grantLocked = new Promise<void>((resolve) => (locked = resolve))

    // An item write as the API does it: the writer's grant FOR SHARE, then the insert.
    const writer = commit(w1('mem'), async (trx) => {
      await sql`SELECT 1 FROM hub_grant WHERE workspace_id = 'w1' AND hub_id = ${id}
                  AND principal_id = 'mem' FOR SHARE`.execute(trx)
      locked()
      await held
      await sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, updated_by)
                VALUES ('w1', ${`${id}-i`}, ${id}, ${id}, 1, 'mem')`.execute(trx)
    })
    await grantLocked
    const deleting = attempt(w1('own'), deleteHub(id))
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await writer
    expect(await deleting).toBe('16B04')
  })
})
