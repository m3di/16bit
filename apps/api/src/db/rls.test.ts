import type { FastifyInstance } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'
import { hashAgentSecret } from '../auth/agent-key.ts'
import { hashToken } from '../auth/session.ts'
import { ensureAppLogin } from './app-role.ts'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { unsafeRoleReason } from './scope.ts'
import { createTestDatabase } from './test-database.ts'

// Row-level security (#44): raw queries as the API's role, with the caller set the way the API
// sets it, a wrong one, or none. Then the HTTP routes that run before any workspace is set.

const SCOPED = [
  'workspace',
  'principal',
  'invite',
  'agent_key',
  'access_log',
  'folder',
  'attribute',
  'folder_attribute',
  'item',
  'item_index',
  'link',
  'revision',
  'hub_grant',
] as const
type Scoped = (typeof SCOPED)[number]

const SESSION = 'rls-session-token'
const AGENT_SECRET = `16b_${'R'.repeat(43)}`

let db: Kysely<Database>
let appDb: Kysely<Database>
let appUrl: string
let drop: () => Promise<void>

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  appUrl = test.appUrl
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
 * Two workspaces that reuse IDs on purpose (principal `mem`, hub `h1`, item `i1`), so a policy
 * that forgot `workspace_id` would show up.
 */
async function fixtures(): Promise<void> {
  await sql`
    INSERT INTO account (id, email, password_hash, name) VALUES
      ('acc-mem', 'mem@example.test', '$argon2id$x', 'Mem');
    INSERT INTO session (id_hash, account_id, expires_at)
      VALUES (${sql.lit(hashToken(SESSION))}, 'acc-mem', now() + interval '1 day');

    INSERT INTO workspace (id, name) VALUES ('w1', 'One'), ('w2', 'Two');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role, account_id) VALUES
      ('w1', 'own', 'user', 'Owner', 'owner', NULL),
      ('w1', 'adm', 'user', 'Admin', 'admin', NULL),
      ('w1', 'mem', 'user', 'Member', 'member', 'acc-mem'),
      ('w1', 'vw', 'user', 'Viewer', 'viewer', NULL),
      ('w1', 'out', 'user', 'Outsider', 'member', NULL),
      ('w1', 'ag', 'agent', 'Agent', 'member', NULL),
      ('w2', 'own2', 'user', 'Owner 2', 'owner', NULL),
      ('w2', 'mem', 'user', 'Member', 'member', NULL);
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role, removed_at)
      VALUES ('w1', 'gone', 'user', 'Gone', 'member', now());

    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'Hub 1', 'blue', 'A'),
      ('w1', 'h2', 'h2', NULL, 'Hub 2', 'red', 'B'),
      ('w2', 'h1', 'h1', NULL, 'Other hub', 'green', 'C');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
      VALUES ('w1', 'f1', 'h1', 'h1', 'Folder', 'blue', 'F');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, indexed) VALUES
      ('w1', 'a1', 'h1', 'Title', 'text', true),
      ('w1', 'a2', 'h2', 'Title', 'text', true),
      ('w1', 'rel', 'h1', 'Links', 'relation', false),
      ('w2', 'a1', 'h1', 'Title', 'text', true);
    UPDATE attribute SET config = '{"targetHubId":"h2","crossHub":true,"multiple":true}'
      WHERE workspace_id = 'w1' AND id = 'rel';
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position) VALUES
      ('w1', 'h1', 'f1', 'a1', 0), ('w1', 'h1', 'f1', 'rel', 1),
      ('w1', 'h2', 'h2', 'a2', 0), ('w2', 'h1', 'h1', 'a1', 0);
    INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by) VALUES
      ('w1', 'i1', 'h1', 'f1', 1, '{"a1":"one","rel":["i2"]}', 'own'),
      ('w1', 'i2', 'h2', 'h2', 1, '{"a2":"two"}', 'own'),
      ('w2', 'i1', 'h1', 'h1', 1, '{"a1":"other"}', 'own2');
    INSERT INTO item_index (workspace_id, attribute_id, item_id, txt) VALUES
      ('w1', 'a1', 'i1', 'one'), ('w1', 'a2', 'i2', 'two'), ('w2', 'a1', 'i1', 'other');
    INSERT INTO link (workspace_id, from_item, attribute_id, to_item)
      VALUES ('w1', 'i1', 'rel', 'i2');
    INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor) VALUES
      ('w1', 1, 'i1', 'h1', 1, '{"op":"create"}', 'own'),
      ('w1', 2, 'i2', 'h2', 1, '{"op":"create"}', 'own'),
      ('w2', 1, 'i1', 'h1', 1, '{"op":"create"}', 'own2');
    UPDATE workspace SET next_revision_seq = 3 WHERE id = 'w1';
    UPDATE workspace SET next_revision_seq = 2 WHERE id = 'w2';

    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role) VALUES
      ('w1', 'h1', 'own', 'hub_admin'),
      ('w1', 'h1', 'mem', 'editor'),
      ('w1', 'h1', 'vw', 'editor'),
      ('w1', 'h1', 'gone', 'editor'),
      ('w2', 'h1', 'own2', 'hub_admin'),
      ('w2', 'h1', 'mem', 'hub_admin');
    INSERT INTO hub_grant (workspace_id, hub_id, principal_id, principal_kind, hub_role)
      VALUES ('w1', 'h1', 'ag', 'agent', 'viewer');
    INSERT INTO agent_key (workspace_id, principal_id, secret_hash, created_by)
      VALUES ('w1', 'ag', ${sql.lit(hashAgentSecret(AGENT_SECRET))}, 'own');
    INSERT INTO invite (workspace_id, id, token_hash, workspace_role, created_by, expires_at)
      VALUES ('w1', 'inv', 'tok', 'member', 'own', now() + interval '1 day'),
             ('w2', 'inv', 'tok2', 'member', 'own2', now() + interval '1 day');
    INSERT INTO access_log (workspace_id, seq, actor, action, target) VALUES
      ('w1', 1, 'own', 'grant.set', 'mem'), ('w2', 1, 'own2', 'grant.set', 'mem');
  `.execute(db)
}

/** Runs `fn` as the API's role with the caller set as the API sets it; null leaves it unset. */
async function as<T>(
  scope: { workspaceId: string; principalId: string } | null,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return appDb.transaction().execute(async (trx) => {
    if (scope) {
      await sql`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true),
                       set_config('app.principal_id', ${scope.principalId}, true)`.execute(trx)
    }
    return fn(trx)
  })
}

async function counts(trx: Transaction<Database>): Promise<Record<Scoped, number>> {
  const out = {} as Record<Scoped, number>
  for (const table of SCOPED) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(table)}
    `.execute(trx)
    out[table] = rows[0]?.n ?? -1
  }
  return out
}

const none = Object.fromEntries(SCOPED.map((t) => [t, 0])) as Record<Scoped, number>

/** SQLSTATE of a failed statement run in its own transaction, or 'ok'. */
async function failure(
  scope: { workspaceId: string; principalId: string } | null,
  statement: (trx: Transaction<Database>) => Promise<unknown>,
): Promise<string> {
  try {
    await as(scope, statement)
    return 'ok'
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

const INSUFFICIENT_PRIVILEGE = '42501' // also what an RLS WITH CHECK violation raises

describe('the API role', () => {
  it('is not the owner, not a superuser and cannot bypass RLS', async () => {
    expect(await unsafeRoleReason(appDb)).toBeNull()
    expect(await unsafeRoleReason(db)).toMatch(/superuser|owns|bypasses/)
    const { rows } = await sql<{ relname: string; relrowsecurity: boolean }>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname <> ALL (ARRAY['kysely_migration', 'kysely_migration_lock'])
      ORDER BY relname
    `.execute(db)
    // Every workspace-scoped table, and only those: account and session stay outside (D46).
    expect(rows.filter((r) => r.relrowsecurity).map((r) => r.relname)).toEqual([...SCOPED].sort())
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([
      'account',
      'session',
    ])
  })

  it('may execute the three auth lookups, and PUBLIC may not', async () => {
    const { rows } = await sql<{ fn: string; app: boolean; public_acl: boolean }>`
      SELECT p.proname AS fn,
             has_function_privilege(current_user, p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_acl
      FROM pg_proc p
      WHERE p.proname IN ('auth_agent_key', 'account_memberships', 'redeem_invite')
      ORDER BY p.proname
    `.execute(appDb)
    expect(rows).toEqual([
      { fn: 'account_memberships', app: true, public_acl: false },
      { fn: 'auth_agent_key', app: true, public_acl: false },
      { fn: 'redeem_invite', app: true, public_acl: false },
    ])
  })

  it('creates its login role once and refuses the owner user', async () => {
    const owner = process.env['MIGRATION_DATABASE_URL'] ?? ''
    const role = decodeURIComponent(new URL(appUrl).username)
    expect(await ensureAppLogin(owner, appUrl)).toBe(role)
    expect(await ensureAppLogin(owner, appUrl)).toBe(role)
    expect(await ensureAppLogin(owner, owner)).toBeNull()
  })
})

describe('raw queries as the API role', () => {
  it('see nothing without a caller, and refuse writes', async () => {
    expect(await as(null, counts)).toEqual(none)
    expect(
      await failure(null, (trx) =>
        trx
          .insertInto('item')
          .values({
            workspace_id: 'w1',
            id: 'x',
            hub_id: 'h1',
            folder_id: 'f1',
            seq_id: 99,
            values: '{}',
            updated_by: 'own',
          })
          .execute(),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    // account and session are outside RLS (D46): the auth code reads them before any scope.
    const accounts = await as(null, (trx) => trx.selectFrom('account').select('id').execute())
    expect(accounts).toHaveLength(1)
  })

  it('see nothing with a principal that is not an active member of the workspace', async () => {
    for (const principalId of ['nobody', 'gone', 'own2']) {
      expect(await as({ workspaceId: 'w1', principalId }, counts), principalId).toEqual(none)
    }
    // A real principal of w1, pointed at w2 where it is not a member.
    expect(await as({ workspaceId: 'w2', principalId: 'own' }, counts)).toEqual(none)
    // A missing workspace.
    expect(await as({ workspaceId: 'nope', principalId: 'own' }, counts)).toEqual(none)
  })

  it('never see another workspace, even where IDs collide', async () => {
    const seen = await as({ workspaceId: 'w2', principalId: 'mem' }, async (trx) => {
      const out: Record<string, string[]> = {}
      for (const table of SCOPED) {
        const col = table === 'workspace' ? 'id' : 'workspace_id'
        const { rows } = await sql<{ w: string }>`
          SELECT DISTINCT ${sql.ref(col)} AS w FROM ${sql.table(table)}
        `.execute(trx)
        out[table] = rows.map((r) => r.w)
      }
      return out
    })
    for (const [table, workspaces] of Object.entries(seen)) {
      expect(
        workspaces.every((w) => w === 'w2'),
        table,
      ).toBe(true)
    }
    // w2's `mem` is hub admin of w2's h1 and sees its item, never w1's i1 with the same ID.
    const items = await as({ workspaceId: 'w2', principalId: 'mem' }, (trx) =>
      trx.selectFrom('item').select(['workspace_id', 'id', 'values']).execute(),
    )
    expect(items).toEqual([{ workspace_id: 'w2', id: 'i1', values: { a1: 'other' } }])
  })

  it('refuse writes into another workspace, and change nothing there', async () => {
    const w1mem = { workspaceId: 'w1', principalId: 'mem' }
    expect(
      await failure(w1mem, (trx) =>
        trx
          .insertInto('item')
          .values({
            workspace_id: 'w2',
            id: 'x',
            hub_id: 'h1',
            folder_id: 'h1',
            seq_id: 99,
            values: '{}',
            updated_by: 'mem',
          })
          .execute(),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    const touched = await as(w1mem, async (trx) => {
      const u = await trx
        .updateTable('item')
        .set({ values: '{}' })
        .where('workspace_id', '=', 'w2')
        .executeTakeFirst()
      const d = await trx
        .deleteFrom('hub_grant')
        .where('workspace_id', '=', 'w2')
        .executeTakeFirst()
      return [Number(u.numUpdatedRows), Number(d.numDeletedRows)]
    })
    expect(touched).toEqual([0, 0])
    const w2 = await db
      .selectFrom('item')
      .select('values')
      .where('workspace_id', '=', 'w2')
      .execute()
    expect(w2).toEqual([{ values: { a1: 'other' } }])
  })

  it('see inside a hub only with a grant, owners and admins included (D45)', async () => {
    const visible = async (principalId: string) =>
      as({ workspaceId: 'w1', principalId }, async (trx) => ({
        hubs: (await trx.selectFrom('folder').select('id').where('parent_id', 'is', null).execute())
          .map((r) => r.id)
          .sort(),
        items: (await trx.selectFrom('item').select('id').execute()).map((r) => r.id).sort(),
        attributes: (await trx.selectFrom('attribute').select('id').execute())
          .map((r) => r.id)
          .sort(),
        revisions: (await trx.selectFrom('revision').select('item_id').execute()).map(
          (r) => r.item_id,
        ),
        links: (await trx.selectFrom('link').select('to_item').execute()).length,
      }))
    // The member holds a grant on h1 only: h2's item, attribute and revision stay hidden, but
    // the link from h1's item (its source) is visible, as the relation value is.
    expect(await visible('mem')).toEqual({
      hubs: ['h1'],
      items: ['i1'],
      attributes: ['a1', 'rel'],
      revisions: ['i1'],
      links: 1,
    })
    // The admin holds no grant: every hub's row (for the hub list), nothing inside.
    expect(await visible('adm')).toEqual({
      hubs: ['h1', 'h2'],
      items: [],
      attributes: [],
      revisions: [],
      links: 0,
    })
    // The agent's one grant is h1, as a viewer.
    expect((await visible('ag')).items).toEqual(['i1'])
  })

  it('let editors write items, and refuse viewers, capped roles and agents with read only', async () => {
    const patch = (principalId: string) =>
      failure({ workspaceId: 'w1', principalId }, async (trx) => {
        const r = await trx
          .updateTable('item')
          .set({ values: '{"a1":"changed"}', updated_by: principalId })
          .where('workspace_id', '=', 'w1')
          .where('id', '=', 'i1')
          .executeTakeFirst()
        if (Number(r.numUpdatedRows) !== 1) throw Object.assign(new Error('no row'), { code: '0' })
        throw Object.assign(new Error('rollback'), { code: 'rolled-back' })
      })
    expect(await patch('mem')).toBe('rolled-back') // the update went through
    // vw holds an editor grant but is a workspace viewer, so acts as viewer (docs/ROLES.md).
    expect(await patch('vw')).toBe(INSUFFICIENT_PRIVILEGE)
    expect(await patch('ag')).toBe(INSUFFICIENT_PRIVILEGE)
    // Writing as someone else is refused too.
    expect(
      await failure({ workspaceId: 'w1', principalId: 'mem' }, (trx) =>
        trx
          .updateTable('item')
          .set({ values: '{}', updated_by: 'own' })
          .where('workspace_id', '=', 'w1')
          .where('id', '=', 'i1')
          .execute(),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('keep access_log and revision append-only and grants unchangeable by their holder', async () => {
    const own = { workspaceId: 'w1', principalId: 'own' }
    expect(
      await failure(own, (trx) =>
        trx.deleteFrom('revision').where('workspace_id', '=', 'w1').execute(),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    expect(
      await failure(own, (trx) =>
        trx
          .updateTable('access_log')
          .set({ action: 'x' })
          .where('workspace_id', '=', 'w1')
          .execute(),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    // An editor can't raise their own grant.
    expect(
      await failure({ workspaceId: 'w1', principalId: 'mem' }, (trx) =>
        trx
          .updateTable('hub_grant')
          .set({ hub_role: 'hub_admin' })
          .where('workspace_id', '=', 'w1')
          .where('principal_id', '=', 'mem')
          .execute(),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('answer the policy helpers only about the caller, in its own workspace', async () => {
    const { rows } = await as({ workspaceId: 'w1', principalId: 'mem' }, (trx) =>
      sql<{ targets: number; hidden: number; elsewhere: number }>`
        SELECT (SELECT count(*)::int FROM lock_link_targets(ARRAY['i1', 'i2', 'nope'])) AS targets,
               hidden_backlinks('i2', 10)::int AS hidden,
               -- i1 also exists in w2: only w1's comes back, once.
               (SELECT count(*)::int FROM lock_link_targets(ARRAY['i1'])) AS elsewhere
      `.execute(trx),
    )
    // Both w1 items exist (a stored link may point into a hidden hub); i2 isn't readable to
    // mem, so its backlinks aren't counted for mem.
    expect(rows[0]).toEqual({ targets: 2, hidden: 0, elsewhere: 1 })
    const outsider = await as({ workspaceId: 'w1', principalId: 'nobody' }, (trx) =>
      sql<{
        n: number
      }>`SELECT count(*)::int AS n FROM lock_link_targets(ARRAY['i1', 'i2'])`.execute(trx),
    )
    expect(outsider.rows[0]?.n).toBe(0)
  })
})

describe('routes that run before a workspace is set', () => {
  let app: FastifyInstance
  beforeAll(() => {
    // No devDb: the API's role alone, as in a deployment.
    app = buildApp({ db: appDb, devApiKey: 'dev-key', devPrincipalId: 'own', secureCookies: false })
  })
  afterAll(async () => {
    await app.close()
  })

  const cookie = { cookie: `sid=${SESSION}` }
  const bearer = { authorization: `Bearer ${AGENT_SECRET}` }

  it('GET /v1/workspaces lists a person’s workspaces through account_memberships', async () => {
    const res = await app.inject({ url: '/v1/workspaces', headers: cookie })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ items: { id: string }[] }>().items.map((w) => w.id)).toEqual(['w1'])
  })

  it('GET /v1/workspaces lists an agent’s one workspace from its key', async () => {
    const res = await app.inject({ url: '/v1/workspaces', headers: bearer })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ items: { id: string; name: string }[] }>().items).toMatchObject([
      { id: 'w1', name: 'One' },
    ])
  })

  it('GET /v1/me answers for a person and for an agent', async () => {
    const person = await app.inject({ url: '/v1/me', headers: cookie })
    expect(person.statusCode).toBe(200)
    expect(person.json()).toMatchObject({
      kind: 'person',
      account: { id: 'acc-mem' },
      memberships: [{ workspace: { id: 'w1', name: 'One' }, principalId: 'mem' }],
    })
    const agent = await app.inject({ url: '/v1/me', headers: bearer })
    expect(agent.statusCode).toBe(200)
    expect(agent.json()).toMatchObject({
      kind: 'agent',
      workspace: { id: 'w1' },
      hub: { id: 'h1', name: 'Hub 1' },
      hubRole: 'viewer',
    })
  })

  it('workspace routes work as the session’s principal, and hide other workspaces', async () => {
    const hubs = await app.inject({ url: '/v1/workspaces/w1/hubs', headers: cookie })
    expect(hubs.statusCode).toBe(200)
    expect(hubs.json<{ items: { id: string }[] }>().items.map((h) => h.id)).toEqual(['h1'])
    const other = await app.inject({ url: '/v1/workspaces/w2/hubs', headers: cookie })
    expect(other.statusCode).toBe(404)
  })

  it('the dev key sees no workspace list without the owner connection, until #51', async () => {
    const res = await app.inject({
      url: '/v1/workspaces',
      headers: { authorization: 'Bearer dev-key' },
    })
    expect(res.json()).toEqual({ items: [], nextCursor: null })
    // Its workspace routes still resolve under RLS.
    const hubs = await app.inject({
      url: '/v1/workspaces/w1/hubs',
      headers: { authorization: 'Bearer dev-key' },
    })
    expect(hubs.statusCode).toBe(200)
  })
})

describe('locks that hold access steady during a write', () => {
  let app: FastifyInstance
  beforeAll(() => {
    app = buildApp({ db: appDb, devApiKey: 'dev-key', devPrincipalId: 'mem' })
  })
  afterAll(async () => {
    await app.close()
  })

  /** Resolves once a backend of this database waits on a lock, or rejects after 5 s. */
  async function someoneWaits(): Promise<void> {
    const name = new URL(appUrl).pathname.slice(1)
    for (let i = 0; i < 100; i++) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = ${name} AND wait_event_type = 'Lock'
      `.execute(db)
      if ((rows[0]?.n ?? 0) > 0) return
      await new Promise((r) => {
        setTimeout(r, 50)
      })
    }
    throw new Error('no backend waited on a lock')
  }

  it('checks the hub grant inside the write transaction: a concurrent revoke wins or waits', async () => {
    const before = await db
      .selectFrom('item')
      .select(['version', 'values'])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'i1')
      .executeTakeFirstOrThrow()
    // Revoke mem's grant in a transaction that has not committed yet.
    const res = await db.connection().execute(async (conn) => {
      await sql`BEGIN`.execute(conn)
      await sql`DELETE FROM hub_grant WHERE workspace_id = 'w1' AND hub_id = 'h1' AND principal_id = 'mem'`.execute(
        conn,
      )
      const request = app.inject({
        method: 'PATCH',
        url: '/v1/workspaces/w1/items/i1',
        headers: { authorization: 'Bearer dev-key' },
        payload: { version: before.version, values: { a1: 'after revoke' } },
      })
      // The write's FOR SHARE on the grant waits for the revoke instead of reading the old row.
      await someoneWaits()
      await sql`COMMIT`.execute(conn)
      return request
    })
    expect(res.statusCode).toBe(404)
    const after = await db
      .selectFrom('item')
      .select(['version', 'values'])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'i1')
      .executeTakeFirstOrThrow()
    expect(after).toEqual(before)
    await db
      .insertInto('hub_grant')
      .values({ workspace_id: 'w1', hub_id: 'h1', principal_id: 'mem', hub_role: 'editor' })
      .execute()
  })

  it('refuses a member change by a non-manager before touching the owner rows', async () => {
    const res = await db.connection().execute(async (conn) => {
      await sql`BEGIN`.execute(conn)
      // Hold every owner row, as a concurrent role change would.
      await sql`SELECT id FROM principal WHERE workspace_id = 'w1' AND workspace_role = 'owner' FOR UPDATE`.execute(
        conn,
      )
      try {
        return await Promise.race([
          app.inject({
            method: 'PATCH',
            url: '/v1/workspaces/w1/members/out',
            headers: { authorization: 'Bearer dev-key' },
            payload: { workspaceRole: 'viewer' },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              reject(new Error('waited on the owner rows'))
            }, 3000),
          ),
        ])
      } finally {
        await sql`ROLLBACK`.execute(conn)
      }
    })
    expect(res.statusCode).toBe(403)
  })
})
