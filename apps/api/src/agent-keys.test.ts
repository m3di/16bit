import { createHash } from 'node:crypto'
import {
  agentKeyPageSchema,
  agentKeySchema,
  createdAgentKeySchema,
  hubPageSchema,
  meSchema,
  workspacePageSchema,
  type AgentKey,
  type CreatedAgentKey,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { SESSION_COOKIE } from './auth/session.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { encodeCursor } from './http.ts'
import { createItem } from './items.ts'

// Integration tests for agent keys (#42, D47, D48, docs/ROLES.md) against a real Postgres.
// People are authenticated with test sessions (db/test-session.ts); sign-in itself is covered
// in auth/auth.test.ts.

let db: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
/** One test session per person, made on first use. */
const sessions = new Map<string, { cookie: string }>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  await seed()
  app = buildApp({ db })
})

afterEach(async () => {
  await app.close()
  sessions.clear()
  await db.destroy()
  await drop()
})

/** A session for the person `principalId`, made on first use. */
async function as(principalId: string): Promise<{ cookie: string }> {
  let session = sessions.get(principalId)
  if (!session) {
    session = await sessionCookie(db, principalId)
    sessions.set(principalId, session)
  }
  return session
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** A request as a person, through a test session. */
const person = async (who: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url, headers: await as(who), payload })

/** A request with an agent secret as the bearer token. */
const agent = (secret: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${secret}` }, payload })

/**
 * w1, hubs `build` (folder `bugs`, attribute `title`) and `docs`, with one item in each.
 * Principals in w1 and their grants:
 *   own   owner,  no grants
 *   adm   admin,  viewer on build
 *   ha    member, hub_admin on build
 *   ed    member, editor on build
 *   vw    viewer, hub_admin on build (acts as viewer)
 * w2 has its own owner `own2` (hub_admin on `secret`).
 */
async function seed(): Promise<void> {
  await db
    .insertInto('workspace')
    .values([
      { id: 'w1', name: 'Alpha' },
      { id: 'w2', name: 'Other' },
    ])
    .execute()
  const p = (
    workspace_id: string,
    id: string,
    workspace_role: 'owner' | 'admin' | 'member' | 'viewer',
  ) => ({ workspace_id, id, kind: 'user' as const, name: id, workspace_role })
  await db
    .insertInto('principal')
    .values([
      p('w1', 'own', 'owner'),
      p('w1', 'adm', 'admin'),
      p('w1', 'ha', 'member'),
      p('w1', 'ed', 'member'),
      p('w1', 'vw', 'viewer'),
      p('w2', 'own2', 'owner'),
    ])
    .execute()
  const hub = (workspace_id: string, id: string) => ({
    workspace_id,
    id,
    hub_id: id,
    parent_id: null,
    name: id,
    color: 'blue',
    id_prefix: 'H',
  })
  await db
    .insertInto('folder')
    .values([hub('w1', 'build'), hub('w1', 'docs'), hub('w2', 'secret')])
    .execute()
  await db
    .insertInto('folder')
    .values({ ...hub('w1', 'bugs'), hub_id: 'build', parent_id: 'build' })
    .execute()
  await db
    .insertInto('attribute')
    .values({
      workspace_id: 'w1',
      id: 'title',
      hub_id: 'build',
      name: 'Title',
      type: 'text',
      config: {},
    })
    .execute()
  await db
    .insertInto('folder_attribute')
    .values({
      workspace_id: 'w1',
      hub_id: 'build',
      folder_id: 'build',
      attribute_id: 'title',
      position: 0,
      required: false,
    })
    .execute()
  const g = (
    workspace_id: string,
    hub_id: string,
    principal_id: string,
    hub_role: 'hub_admin' | 'editor' | 'viewer',
  ) => ({ workspace_id, hub_id, principal_id, hub_role })
  await db
    .insertInto('hub_grant')
    .values([
      g('w1', 'build', 'adm', 'viewer'),
      g('w1', 'build', 'ha', 'hub_admin'),
      g('w1', 'build', 'ed', 'editor'),
      g('w1', 'build', 'vw', 'hub_admin'),
      g('w2', 'secret', 'own2', 'hub_admin'),
    ])
    .execute()
  for (const [id, folder] of [
    ['b1', 'build'],
    ['d1', 'docs'],
  ] as const) {
    // Straight through the write path: `own` holds no grant, so the API would hide both hubs.
    await createItem(db, 'w1', 'own', { id, folderId: folder, values: {} })
  }
}

async function createKey(
  who: string,
  hubRole: 'editor' | 'commenter' | 'viewer',
  extra: { hub?: string; workspace?: string; expiresAt?: string } = {},
): Promise<CreatedAgentKey> {
  const res = await person(
    who,
    'POST',
    `/v1/workspaces/${extra.workspace ?? 'w1'}/hubs/${extra.hub ?? 'build'}/agent-keys`,
    { name: `${hubRole} bot`, hubRole, expiresAt: extra.expiresAt ?? null },
  )
  expect(res.statusCode, res.body).toBe(201)
  return createdAgentKeySchema.parse(res.json())
}

const accessLog = (workspaceId = 'w1') =>
  db
    .selectFrom('access_log')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .orderBy('seq')
    .execute()

describe('creating a key', () => {
  it('creates the agent principal, its one grant, the hashed key and a log entry', async () => {
    const res = await person('ha', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
      name: '  Triage bot ',
      hubRole: 'editor',
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers['cache-control']).toBe('no-store')
    const { key, secret } = createdAgentKeySchema.parse(res.json())
    expect(key).toMatchObject({
      workspaceId: 'w1',
      name: 'Triage bot',
      hubId: 'build',
      hubRole: 'editor',
      createdBy: 'ha',
      expiresAt: null,
      revokedAt: null,
    })
    expect(secret).toMatch(/^16b_[A-Za-z0-9_-]{43}$/)

    const principal = await db
      .selectFrom('principal')
      .selectAll()
      .where('workspace_id', '=', 'w1')
      .where('id', '=', key.id)
      .executeTakeFirstOrThrow()
    expect(principal).toMatchObject({ kind: 'agent', workspace_role: 'member', name: 'Triage bot' })
    const grants = await db
      .selectFrom('hub_grant')
      .selectAll()
      .where('workspace_id', '=', 'w1')
      .where('principal_id', '=', key.id)
      .execute()
    expect(grants).toEqual([
      {
        workspace_id: 'w1',
        hub_id: 'build',
        principal_id: key.id,
        principal_kind: 'agent',
        hub_role: 'editor',
      },
    ])
    const row = await db
      .selectFrom('agent_key')
      .selectAll()
      .where('workspace_id', '=', 'w1')
      .where('principal_id', '=', key.id)
      .executeTakeFirstOrThrow()
    // Stored hashed only: the secret never reaches the database.
    expect(row.secret_hash).toBe(createHash('sha256').update(secret).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(secret.slice(4))

    const log = await accessLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      seq: 1,
      actor: 'ha',
      action: 'key.create',
      target: key.id,
      detail: { hubId: 'build', hubRole: 'editor', name: 'Triage bot', expiresAt: null },
    })
    expect(JSON.stringify(log)).not.toContain(secret.slice(4))
  })

  it('lets owners and admins with a grant create keys up to their own hub role', async () => {
    // adm holds viewer on build: viewer keys only (least privilege).
    await createKey('adm', 'viewer')
    const res = await person('adm', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
      name: 'x',
      hubRole: 'commenter',
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'forbidden' })

    // own holds no grant: refused until they grant themselves access (D45, footnote 2).
    const noGrant = await person('own', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
      name: 'x',
      hubRole: 'viewer',
    })
    expect(noGrant.statusCode).toBe(403)
    await db
      .insertInto('hub_grant')
      .values({ workspace_id: 'w1', hub_id: 'build', principal_id: 'own', hub_role: 'editor' })
      .execute()
    await createKey('own', 'editor')
  })

  it('refuses people who are not owner, admin or hub admin of the hub', async () => {
    const body = { name: 'x', hubRole: 'viewer' }
    // An editor sees the hub but may not make keys.
    expect(
      (await person('ed', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', body)).statusCode,
    ).toBe(403)
    // A viewer with a hub_admin grant acts as viewer.
    expect(
      (await person('vw', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', body)).statusCode,
    ).toBe(403)
    // A hub the member holds no grant on does not exist for them.
    const hidden = await person('ha', 'POST', '/v1/workspaces/w1/hubs/docs/agent-keys', body)
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toMatchObject({ error: 'not_found', message: 'Hub not found' })
    // A missing hub, a subfolder, and another workspace are all 404.
    expect(
      (await person('ha', 'POST', '/v1/workspaces/w1/hubs/nope/agent-keys', body)).statusCode,
    ).toBe(404)
    expect(
      (await person('ha', 'POST', '/v1/workspaces/w1/hubs/bugs/agent-keys', body)).statusCode,
    ).toBe(404)
    expect(
      (await person('ha', 'POST', '/v1/workspaces/w2/hubs/secret/agent-keys', body)).statusCode,
    ).toBe(404)
    expect(await db.selectFrom('agent_key').select('principal_id').execute()).toEqual([])
    expect(await accessLog()).toEqual([])
  })

  it('rejects invalid input', async () => {
    const url = '/v1/workspaces/w1/hubs/build/agent-keys'
    for (const body of [
      { name: 'x', hubRole: 'hub_admin' },
      { name: '   ', hubRole: 'viewer' },
      { hubRole: 'viewer' },
      { name: 'x', hubRole: 'viewer', expiresAt: 'tomorrow' },
      { name: 'x', hubRole: 'viewer', extra: true },
      { name: 'x', hubRole: 'viewer', expiresAt: new Date(Date.now() - 1000).toISOString() },
    ]) {
      const res = await person('ha', 'POST', url, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json()).toMatchObject({ error: 'invalid_request' })
    }
  })

  it('leaves nothing behind when any step fails', async () => {
    // Make the last step of the transaction, the access_log insert, fail.
    await sql`
      CREATE FUNCTION fail_access_log() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER fail_access_log BEFORE INSERT ON access_log
        FOR EACH ROW EXECUTE FUNCTION fail_access_log();
    `.execute(db)
    const res = await person('ha', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
      name: 'x',
      hubRole: 'viewer',
    })
    expect(res.statusCode).toBe(500)

    expect(
      await db.selectFrom('principal').select('id').where('kind', '=', 'agent').execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('hub_grant')
        .select('principal_id')
        .where('principal_kind', '=', 'agent')
        .execute(),
    ).toEqual([])
    expect(await db.selectFrom('agent_key').select('principal_id').execute()).toEqual([])
    const { next_access_seq } = await db
      .selectFrom('workspace')
      .select('next_access_seq')
      .where('id', '=', 'w1')
      .executeTakeFirstOrThrow()
    expect(next_access_seq).toBe(1)
  })
})

describe('listing keys', () => {
  it('pages a hub’s keys newest first, revoked ones included', async () => {
    const made: AgentKey[] = []
    for (const role of ['viewer', 'commenter', 'editor'] as const)
      made.push((await createKey('ha', role)).key)
    await person('own', 'POST', `/v1/workspaces/w1/agent-keys/${made[0]?.id ?? ''}/revoke`)

    const seen: AgentKey[] = []
    let cursor: string | null = null
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : ''
      const res = await person('adm', 'GET', `/v1/workspaces/w1/hubs/build/agent-keys?limit=1${qs}`)
      expect(res.statusCode).toBe(200)
      const page = agentKeyPageSchema.parse(res.json())
      expect(page.items).toHaveLength(1)
      seen.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)

    expect(seen.map((k) => k.id)).toEqual(made.map((k) => k.id).reverse())
    expect(seen.at(-1)?.revokedAt).not.toBeNull()
    // No secret or hash in the listing.
    expect(JSON.stringify(seen)).not.toMatch(/secret|hash|16b_/i)
  })

  it('only lists a hub’s own keys and follows the matrix', async () => {
    await createKey('ha', 'viewer')
    const own = await person('own', 'GET', '/v1/workspaces/w1/hubs/build/agent-keys')
    expect(own.statusCode).toBe(403) // no grant on build
    expect((await person('ed', 'GET', '/v1/workspaces/w1/hubs/build/agent-keys')).statusCode).toBe(
      403,
    )
    expect((await person('ha', 'GET', '/v1/workspaces/w1/hubs/docs/agent-keys')).statusCode).toBe(
      404,
    )
    await db
      .insertInto('hub_grant')
      .values({ workspace_id: 'w1', hub_id: 'docs', principal_id: 'own', hub_role: 'hub_admin' })
      .execute()
    const docs = await person('own', 'GET', '/v1/workspaces/w1/hubs/docs/agent-keys')
    expect(agentKeyPageSchema.parse(docs.json()).items).toEqual([])
  })

  it('rejects a malformed cursor', async () => {
    for (const cursor of ['nope', Buffer.from('["x","y"]').toString('base64url')]) {
      const res = await person(
        'ha',
        'GET',
        `/v1/workspaces/w1/hubs/build/agent-keys?cursor=${cursor}`,
      )
      expect(res.statusCode).toBe(400)
    }
  })
})

describe('revoking a key', () => {
  it('lets an owner revoke any key without a grant, logs it, and the key stops working', async () => {
    const { key, secret } = await createKey('ha', 'editor')
    expect((await agent(secret, 'GET', '/v1/workspaces/w1/hubs')).statusCode).toBe(200)

    const res = await person('own', 'POST', `/v1/workspaces/w1/agent-keys/${key.id}/revoke`)
    expect(res.statusCode).toBe(200)
    const revoked = agentKeySchema.parse(res.json())
    expect(revoked.revokedAt).not.toBeNull()

    const after = await agent(secret, 'GET', '/v1/workspaces/w1/hubs')
    expect(after.statusCode).toBe(401)
    expect(after.json()).toMatchObject({ error: 'unauthorized' })

    // Revoking again changes nothing and logs nothing.
    const again = await person('adm', 'POST', `/v1/workspaces/w1/agent-keys/${key.id}/revoke`)
    expect(agentKeySchema.parse(again.json()).revokedAt).toBe(revoked.revokedAt)
    const log = await accessLog()
    expect(log.map((e) => [e.seq, e.action, e.actor, e.target])).toEqual([
      [1, 'key.create', 'ha', key.id],
      [2, 'key.revoke', 'own', key.id],
    ])
    // The principal and its grant stay, so history keeps its actor.
    expect(
      await db.selectFrom('principal').select('id').where('id', '=', key.id).execute(),
    ).toHaveLength(1)
  })

  it('lets the hub’s hub admin revoke, and nobody else', async () => {
    const { key } = await createKey('ha', 'viewer')
    expect(
      (await person('ed', 'POST', `/v1/workspaces/w1/agent-keys/${key.id}/revoke`)).statusCode,
    ).toBe(403)
    expect(
      (await person('vw', 'POST', `/v1/workspaces/w1/agent-keys/${key.id}/revoke`)).statusCode,
    ).toBe(403)
    expect(
      (await person('ha', 'POST', `/v1/workspaces/w1/agent-keys/${key.id}/revoke`)).statusCode,
    ).toBe(200)

    // A key on a hub the member cannot see does not exist for them.
    await db
      .insertInto('hub_grant')
      .values({ workspace_id: 'w1', hub_id: 'docs', principal_id: 'own', hub_role: 'editor' })
      .execute()
    const docsKey = await createKey('own', 'viewer', { hub: 'docs' })
    const hidden = await person(
      'ha',
      'POST',
      `/v1/workspaces/w1/agent-keys/${docsKey.key.id}/revoke`,
    )
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toMatchObject({ message: 'Agent key not found' })
  })

  it('404s an unknown key, a person, and a key from another workspace', async () => {
    const other = await createKey('own2', 'viewer', { workspace: 'w2', hub: 'secret' })
    for (const id of ['nope', 'ed', other.key.id]) {
      const res = await person('own', 'POST', `/v1/workspaces/w1/agent-keys/${id}/revoke`)
      expect(res.statusCode, id).toBe(404)
    }
    expect((await agent(other.secret, 'GET', '/v1/workspaces/w2/hubs')).statusCode).toBe(200)
  })
})

describe('authenticating with a key', () => {
  it('acts as the key’s principal, in its one workspace and hub', async () => {
    const { key, secret } = await createKey('ha', 'editor')

    const workspaces = await agent(secret, 'GET', '/v1/workspaces')
    expect(workspacePageSchema.parse(workspaces.json()).items.map((w) => w.id)).toEqual(['w1'])
    const hubs = await agent(secret, 'GET', '/v1/workspaces/w1/hubs')
    expect(hubPageSchema.parse(hubs.json()).items.map((h) => h.id)).toEqual(['build'])
    expect((await agent(secret, 'GET', '/v1/workspaces/w1/hubs/build')).statusCode).toBe(200)
    expect((await agent(secret, 'GET', '/v1/workspaces/w1/items/b1')).statusCode).toBe(200)
    const query = await agent(secret, 'POST', '/v1/workspaces/w1/query', {
      from: 'bugs',
      limit: 10,
    })
    expect(query.statusCode).toBe(200)

    const created = await agent(secret, 'POST', '/v1/workspaces/w1/items', {
      folderId: 'bugs',
      values: {},
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ hubId: 'build', updatedBy: key.id })
    const patched = await agent(secret, 'PATCH', '/v1/workspaces/w1/items/b1', {
      version: 1,
      values: { title: 'by agent' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({ updatedBy: key.id })
    const revision = await db
      .selectFrom('revision')
      .select('actor')
      .where('item_id', '=', 'b1')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow()
    expect(revision.actor).toBe(key.id)
    expect((await agent(secret, 'DELETE', '/v1/workspaces/w1/items/b1?version=2')).statusCode).toBe(
      204,
    )
  })

  it('hides every other hub and workspace as 404', async () => {
    const { secret } = await createKey('ha', 'editor')
    const cases: [Method, string, object?][] = [
      ['GET', '/v1/workspaces/w1/hubs/docs'],
      ['GET', '/v1/workspaces/w1/items/d1'],
      ['PATCH', '/v1/workspaces/w1/items/d1', { version: 1, values: { x: 1 } }],
      ['DELETE', '/v1/workspaces/w1/items/d1?version=1'],
      ['POST', '/v1/workspaces/w1/items', { folderId: 'docs' }],
      ['POST', '/v1/workspaces/w1/query', { from: 'docs', limit: 10 }],
      ['GET', '/v1/workspaces/w2/hubs'],
      ['GET', '/v1/workspaces/w2/hubs/secret'],
    ]
    for (const [method, url, body] of cases) {
      const res = await agent(secret, method, url, body)
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
    const item = await db
      .selectFrom('item')
      .select('version')
      .where('id', '=', 'd1')
      .executeTakeFirstOrThrow()
    expect(item.version).toBe(1)
  })

  it('holds a key to its role', async () => {
    const writes: [Method, string, object?][] = [
      ['POST', '/v1/workspaces/w1/items', { folderId: 'build' }],
      ['PATCH', '/v1/workspaces/w1/items/b1', { version: 1, values: { title: 'x' } }],
      ['DELETE', '/v1/workspaces/w1/items/b1?version=1'],
    ]
    for (const role of ['viewer', 'commenter'] as const) {
      const { secret } = await createKey('ha', role)
      expect((await agent(secret, 'GET', '/v1/workspaces/w1/items/b1')).statusCode).toBe(200)
      for (const [method, url, body] of writes) {
        const res = await agent(secret, method, url, body)
        expect(res.statusCode, `${role} ${method} ${url}`).toBe(403)
        expect(res.json()).toMatchObject({ error: 'forbidden' })
      }
    }
    // Agents never manage keys (D28), even an editor key on its own hub.
    const editor = await createKey('ha', 'editor')
    const make = await agent(editor.secret, 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
      name: 'x',
      hubRole: 'viewer',
    })
    expect(make.statusCode).toBe(403)
    expect(
      (await agent(editor.secret, 'GET', '/v1/workspaces/w1/hubs/build/agent-keys')).statusCode,
    ).toBe(403)
    const { key } = await createKey('ha', 'viewer')
    expect(
      (await agent(editor.secret, 'POST', `/v1/workspaces/w1/agent-keys/${key.id}/revoke`))
        .statusCode,
    ).toBe(403)
    // Nor members (D28).
    const invite = await agent(editor.secret, 'POST', '/v1/workspaces/w1/invites', {
      workspaceRole: 'viewer',
    })
    expect(invite.statusCode).toBe(403)
    expect(await db.selectFrom('invite').select('id').execute()).toEqual([])
  })

  it('accepts a key until it expires, then answers 401', async () => {
    const { key, secret } = await createKey('ha', 'viewer', {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect(key.expiresAt).not.toBeNull()
    expect((await agent(secret, 'GET', '/v1/workspaces/w1/hubs')).statusCode).toBe(200)
    await db
      .updateTable('agent_key')
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where('principal_id', '=', key.id)
      .execute()
    expect((await agent(secret, 'GET', '/v1/workspaces/w1/hubs')).statusCode).toBe(401)
  })

  it('accepts the Bearer scheme in any case', async () => {
    const { secret } = await createKey('ha', 'viewer')
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces/w1/hubs',
        headers: { authorization: `${scheme} ${secret}` },
      })
      expect(res.statusCode, scheme).toBe(200)
    }
  })

  it('pages its one workspace from the key lookup alone', async () => {
    const { secret } = await createKey('ha', 'viewer')
    const first = workspacePageSchema.parse(
      (await agent(secret, 'GET', '/v1/workspaces?limit=1')).json(),
    )
    const created = await db
      .selectFrom('workspace')
      .select('created_at')
      .where('id', '=', 'w1')
      .executeTakeFirstOrThrow()
    expect(first).toEqual({
      items: [{ id: 'w1', name: 'Alpha', createdAt: created.created_at.toISOString() }],
      nextCursor: null,
    })
    // One row never yields a next cursor, so any well-formed cursor is past it.
    for (const key of [
      ['Alpha', 'w1'],
      ['A', 'a'],
    ]) {
      const after = await agent(secret, 'GET', `/v1/workspaces?cursor=${encodeCursor(key)}`)
      expect(after.statusCode).toBe(200)
      expect(workspacePageSchema.parse(after.json()).items).toEqual([])
    }
    expect((await agent(secret, 'GET', '/v1/workspaces?cursor=nope')).statusCode).toBe(400)
  })

  it('answers 401 to unknown and malformed tokens', async () => {
    const { secret } = await createKey('ha', 'viewer')
    for (const authorization of [
      `Bearer 16b_${'A'.repeat(43)}`,
      `Bearer ${secret}x`,
      `Bearer ${secret.slice(4)}`,
      `Basic ${secret}`,
      'Bearer ',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces/w1/hubs',
        headers: { authorization },
      })
      expect(res.statusCode, authorization).toBe(401)
    }
  })

  it('resolves through a SECURITY DEFINER function that PUBLIC cannot call', async () => {
    const { rows } = await sql<{ prosecdef: boolean; acl: string; config: string[] }>`
      SELECT prosecdef, proacl::text AS acl, proconfig AS config
      FROM pg_proc WHERE proname = 'auth_agent_key'
    `.execute(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.prosecdef).toBe(true)
    // A PUBLIC entry in an ACL has an empty grantee: `=X/owner`.
    expect(rows[0]?.acl).not.toMatch(/(^|[{,])=/)
    expect(rows[0]?.config).toEqual(['search_path=public, pg_temp'])
  })
})

describe('GET /v1/me with a key', () => {
  it('returns the key’s principal, workspace, hub and role', async () => {
    const { key, secret } = await createKey('ha', 'commenter')
    const res = await agent(secret, 'GET', '/v1/me')
    expect(res.statusCode).toBe(200)
    expect(meSchema.parse(res.json())).toEqual({
      kind: 'agent',
      principalId: key.id,
      workspace: { id: 'w1', name: 'Alpha' },
      hub: { id: 'build', name: 'build' },
      hubRole: 'commenter',
    })

    await db
      .insertInto('hub_grant')
      .values({ workspace_id: 'w2', hub_id: 'secret', principal_id: 'own2', hub_role: 'editor' })
      .onConflict((oc) => oc.doNothing())
      .execute()
    const other = await createKey('own2', 'viewer', { workspace: 'w2', hub: 'secret' })
    expect((await agent(other.secret, 'GET', '/v1/me')).json()).toMatchObject({
      kind: 'agent',
      principalId: other.key.id,
      workspace: { id: 'w2', name: 'Other' },
      hub: { id: 'secret' },
      hubRole: 'viewer',
    })
  })

  it('answers 401 once the key is revoked or expired', async () => {
    const revoked = await createKey('ha', 'viewer')
    await person('own', 'POST', `/v1/workspaces/w1/agent-keys/${revoked.key.id}/revoke`)
    const expired = await createKey('ha', 'viewer')
    await db
      .updateTable('agent_key')
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where('principal_id', '=', expired.key.id)
      .execute()
    for (const { secret } of [revoked, expired]) {
      const res = await agent(secret, 'GET', '/v1/me')
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ error: 'unauthorized' })
    }
  })
})

describe('a session cookie and a bearer token on one request', () => {
  /** The token of a live session for `own`'s person. */
  async function ownSession(): Promise<string> {
    return (await as('own')).cookie.slice(`${SESSION_COOKIE}=`.length)
  }

  it('refuses a cookie with an agent key, valid or not, and changes nothing', async () => {
    const session = await ownSession()
    const { secret } = await createKey('ha', 'viewer')
    const revoked = await createKey('ha', 'viewer')
    await person('own', 'POST', `/v1/workspaces/w1/agent-keys/${revoked.key.id}/revoke`)
    const cases: [string, string][] = [
      [session, secret],
      [session, revoked.secret],
      [session, `16b_${'A'.repeat(43)}`],
      ['not-a-session', secret],
    ]
    for (const [cookie, key] of cases) {
      for (const [method, url, payload] of [
        ['GET', '/v1/me', undefined],
        ['GET', '/v1/workspaces/w1/hubs', undefined],
        ['PATCH', '/v1/workspaces/w1/items/b1', { version: 1, values: { title: 'x' } }],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          headers: { cookie: `${SESSION_COOKIE}=${cookie}`, authorization: `bearer ${key}` },
          payload,
        })
        expect(res.statusCode, `${method} ${url}`).toBe(400)
        expect(res.json()).toMatchObject({
          error: 'invalid_request',
          message: 'Send either a session cookie or a bearer token, not both',
        })
      }
    }
    const item = await db
      .selectFrom('item')
      .select('version')
      .where('id', '=', 'b1')
      .executeTakeFirstOrThrow()
    expect(item.version).toBe(1)

    // Each credential alone still works.
    expect((await agent(secret, 'GET', '/v1/me')).json()).toMatchObject({ kind: 'agent' })
    const alone = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(alone.json()).toMatchObject({ kind: 'person' })
  })

  it('refuses a cookie with any Authorization header, live or not (D49)', async () => {
    const session = await ownSession()
    const expired = await sessionCookie(db, 'ed')
    await db
      .updateTable('session')
      .set({
        created_at: sql`now() - interval '31 days'`,
        expires_at: sql`now() - interval '1 second'`,
      })
      .where('account_id', '=', 'acct-ed')
      .execute()
    const cookies = [`${SESSION_COOKIE}=${session}`, expired.cookie]
    // The old M0 dev key, another scheme, a bare token and an empty header are all refused.
    const headers = ['Bearer dev-only-key', 'Basic b3duOnB3', 'whatever', '']
    for (const cookie of cookies) {
      for (const authorization of headers) {
        for (const [method, url, payload] of [
          ['GET', '/v1/me', undefined],
          ['PATCH', '/v1/workspaces/w1/items/b1', { version: 1, values: { title: 'x' } }],
        ] as const) {
          const res = await app.inject({ method, url, headers: { cookie, authorization }, payload })
          expect(res.statusCode, `${authorization} ${method} ${url}`).toBe(400)
          expect(res.json()).toMatchObject({ error: 'invalid_request' })
        }
      }
    }
    const item = await db
      .selectFrom('item')
      .select('version')
      .where('id', '=', 'b1')
      .executeTakeFirstOrThrow()
    expect(item.version).toBe(1)
  })
})
