import {
  hubDescriptionSchema,
  hubGrantSchema,
  hubListEntrySchema,
  hubPageSchema,
  meSchema,
  memberPageSchema,
  principalSchema,
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
import { createItem } from './items.ts'

// Integration tests for #43 against a real Postgres: every route family checked against every
// role in docs/ROLES.md, plus members, hub grants, hub creation and member removal. People act
// through test sessions (db/test-session.ts); agents through real keys. Access changes must
// land in access_log (D48) and never in `revision`.

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
/** One test session per person, made on first use. */
const sessions = new Map<string, { cookie: string }>()
let editorKey: CreatedAgentKey
let viewerKey: CreatedAgentKey

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  app = buildApp({ db: appDb })
  editorKey = await createKey('editor')
  viewerKey = await createKey('viewer')
})

afterEach(async () => {
  await app.close()
  sessions.clear()
  await appDb.destroy()
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A request as `who`: a principal ID (a session), or an agent secret (a bearer token). */
async function call(who: string, method: Method, url: string, payload?: object) {
  const headers = who.startsWith('16b_') ? { authorization: `Bearer ${who}` } : await as(who)
  return app.inject({ method, url, headers, payload })
}

async function createKey(hubRole: 'editor' | 'viewer'): Promise<CreatedAgentKey> {
  const res = await call('ha', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
    name: `${hubRole} bot`,
    hubRole,
  })
  expect(res.statusCode).toBe(201)
  return res.json<CreatedAgentKey>()
}

/**
 * w1: hubs `build` (folder `bugs`, attribute `title`, item b1) and `docs` (item d1).
 *   own   owner,   no grants          own2  owner,   hub_admin on build
 *   adm   admin,   viewer on build    ha    member,  hub_admin on build
 *   ed    member,  editor on build    cm    member,  commenter on build
 *   vw    viewer,  hub_admin on build (acts as viewer)
 *   fin   finance, editor on build    (acts as viewer)
 *   nog   member,  no grants
 * Agent keys made by `ha` on build: one editor, one viewer.
 * w2: owner `x`, hub `secret`.
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
    workspace_role: Database['principal']['workspace_role'],
  ) => ({ workspace_id, id, kind: 'user' as const, name: id, workspace_role })
  await db
    .insertInto('principal')
    .values([
      p('w1', 'own', 'owner'),
      p('w1', 'own2', 'owner'),
      p('w1', 'adm', 'admin'),
      p('w1', 'ha', 'member'),
      p('w1', 'ed', 'member'),
      p('w1', 'cm', 'member'),
      p('w1', 'vw', 'viewer'),
      p('w1', 'fin', 'finance'),
      p('w1', 'nog', 'member'),
      p('w2', 'x', 'owner'),
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
    .values(
      ['build', 'bugs'].map((folder_id) => ({
        workspace_id: 'w1',
        hub_id: 'build',
        folder_id,
        attribute_id: 'title',
        position: 0,
        required: false,
      })),
    )
    .execute()
  const g = (principal_id: string, hub_role: Database['hub_grant']['hub_role']) => ({
    workspace_id: 'w1',
    hub_id: 'build',
    principal_id,
    hub_role,
  })
  await db
    .insertInto('hub_grant')
    .values([
      g('own2', 'hub_admin'),
      g('adm', 'viewer'),
      g('ha', 'hub_admin'),
      g('ed', 'editor'),
      g('cm', 'commenter'),
      g('vw', 'hub_admin'),
      g('fin', 'editor'),
    ])
    .execute()
  await createItem(db, 'w1', 'own', { id: 'b1', folderId: 'bugs', values: { title: 'Bug' } })
  await createItem(db, 'w1', 'own', { id: 'd1', folderId: 'docs', values: {} })
}

/** access_log of w1 from `seq` on. */
async function logSince(seq: number) {
  return db
    .selectFrom('access_log')
    .select(['actor', 'action', 'target', 'detail'])
    .where('workspace_id', '=', 'w1')
    .where('seq', '>=', seq)
    .orderBy('seq')
    .execute()
}

async function nextLogSeq(): Promise<number> {
  const row = await db
    .selectFrom('workspace')
    .select('next_access_seq')
    .where('id', '=', 'w1')
    .executeTakeFirstOrThrow()
  return row.next_access_seq
}

async function revisionCount(): Promise<number> {
  const { n } = await db
    .selectFrom('revision')
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirstOrThrow()
  return n
}

async function grantOf(hubId: string, principalId: string) {
  const row = await db
    .selectFrom('hub_grant')
    .select('hub_role')
    .where('workspace_id', '=', 'w1')
    .where('hub_id', '=', hubId)
    .where('principal_id', '=', principalId)
    .executeTakeFirst()
  return row?.hub_role ?? null
}

const PEOPLE = ['own', 'adm', 'ha', 'ed', 'cm', 'vw', 'fin', 'nog'] as const
const agents = () => ({ agentEditor: editorKey.secret, agentViewer: viewerKey.secret })
const everyone = (): Record<string, string> => ({
  ...Object.fromEntries(PEOPLE.map((p) => [p, p])),
  ...agents(),
})

describe('hub list', () => {
  it('shows owners and admins every hub, marking those without a grant', async () => {
    const res = await call('own', 'GET', '/v1/workspaces/w1/hubs')
    expect(res.statusCode).toBe(200)
    const { items } = hubPageSchema.parse(res.json())
    expect(items).toEqual([
      { access: 'none', workspaceId: 'w1', id: 'build', name: 'build', color: 'blue' },
      { access: 'none', workspaceId: 'w1', id: 'docs', name: 'docs', color: 'blue' },
    ])

    const adm = hubPageSchema.parse((await call('adm', 'GET', '/v1/workspaces/w1/hubs')).json())
    expect(adm.items.map((h) => [h.id, h.access, h.access === 'granted' && h.hubRole])).toEqual([
      ['build', 'granted', 'viewer'],
      ['docs', 'none', false],
    ])
  })

  it('shows everyone else only the hubs they hold a grant on, with the effective role', async () => {
    const expected: Record<string, [string, string][]> = {
      ha: [['build', 'hub_admin']],
      ed: [['build', 'editor']],
      cm: [['build', 'commenter']],
      vw: [['build', 'viewer']],
      fin: [['build', 'viewer']],
      nog: [],
      agentEditor: [['build', 'editor']],
      agentViewer: [['build', 'viewer']],
    }
    const who = everyone()
    for (const [name, hubs] of Object.entries(expected)) {
      const res = await call(who[name] ?? name, 'GET', '/v1/workspaces/w1/hubs')
      expect(res.statusCode, name).toBe(200)
      const { items } = hubPageSchema.parse(res.json())
      expect(
        items.map((h) => [h.id, h.access === 'granted' ? h.hubRole : 'none']),
        name,
      ).toEqual(hubs)
    }
  })

  it('pages across granted and no-access hubs', async () => {
    const first = hubPageSchema.parse(
      (await call('adm', 'GET', '/v1/workspaces/w1/hubs?limit=1')).json(),
    )
    expect(first.items.map((h) => h.id)).toEqual(['build'])
    const second = hubPageSchema.parse(
      (
        await call(
          'adm',
          'GET',
          `/v1/workspaces/w1/hubs?limit=1&cursor=${String(first.nextCursor)}`,
        )
      ).json(),
    )
    expect(second.items.map((h) => [h.id, h.access])).toEqual([['docs', 'none']])
    expect(second.nextCursor).toBeNull()
  })

  it('never carries an item count on a no-access entry', () => {
    const none = { access: 'none', workspaceId: 'w1', id: 'h', name: 'H', color: 'blue' }
    expect(hubListEntrySchema.safeParse(none).success).toBe(true)
    expect(hubListEntrySchema.safeParse({ ...none, itemCount: 3 }).success).toBe(false)
  })
})

describe('reading inside a hub', () => {
  const reads = (hub: string, folder: string, item: string) =>
    [
      ['GET', `/v1/workspaces/w1/hubs/${hub}`, undefined],
      ['POST', '/v1/workspaces/w1/query', { from: folder, limit: 10 }],
      ['GET', `/v1/workspaces/w1/items/${item}`, undefined],
    ] as const

  it('allows every role with a grant and returns 404 to everyone without one', async () => {
    const allowed = ['adm', 'ha', 'ed', 'cm', 'vw', 'fin', 'agentEditor', 'agentViewer']
    const who = everyone()
    for (const [name, principal] of Object.entries(who)) {
      for (const [method, url, payload] of reads('build', 'bugs', 'b1')) {
        const res = await call(principal, method, url, payload)
        expect(res.statusCode, `${name} ${method} ${url}`).toBe(allowed.includes(name) ? 200 : 404)
      }
      // Nobody holds a grant on docs, owners included (D45).
      for (const [method, url, payload] of reads('docs', 'docs', 'd1')) {
        const res = await call(principal, method, url, payload)
        expect(res.statusCode, `${name} ${method} ${url}`).toBe(404)
      }
    }
  })

  it("describes the hub with the caller's effective role, as the hub list does (#73)", async () => {
    const expected: Record<string, string> = {
      adm: 'viewer',
      ha: 'hub_admin',
      ed: 'editor',
      cm: 'commenter',
      // Capped by the workspace role (docs/ROLES.md).
      vw: 'viewer',
      fin: 'viewer',
      agentEditor: 'editor',
      agentViewer: 'viewer',
    }
    const who = everyone()
    for (const [name, hubRole] of Object.entries(expected)) {
      const principal = who[name] ?? name
      const res = await call(principal, 'GET', '/v1/workspaces/w1/hubs/build')
      expect(res.statusCode, name).toBe(200)
      expect(hubDescriptionSchema.parse(res.json()).hubRole, name).toBe(hubRole)
      const list = await call(principal, 'GET', '/v1/workspaces/w1/hubs')
      const entry = list.json<{ items: { id: string; hubRole?: string }[] }>().items
      expect(entry.find((h) => h.id === 'build')?.hubRole, name).toBe(hubRole)
    }
  })

  it('answers a hidden hub exactly like a missing one', async () => {
    const hidden = await call('own', 'GET', '/v1/workspaces/w1/hubs/docs')
    const missing = await call('own', 'GET', '/v1/workspaces/w1/hubs/nope')
    expect(hidden.json()).toEqual(missing.json())
    const hiddenItem = await call('nog', 'GET', '/v1/workspaces/w1/items/b1')
    const missingItem = await call('nog', 'GET', '/v1/workspaces/w1/items/nope')
    expect(hiddenItem.json()).toEqual(missingItem.json())
    expect(hubDescriptionSchema.safeParse(hidden.json()).success).toBe(false)
  })
})

describe('writing items', () => {
  it('lets hub admins and editors write, refuses visible-but-lower roles with 403', async () => {
    const expected: Record<string, number> = {
      own: 404,
      nog: 404,
      adm: 403,
      cm: 403,
      vw: 403,
      fin: 403,
      agentViewer: 403,
      ha: 201,
      ed: 201,
      agentEditor: 201,
    }
    const who = everyone()
    for (const [name, status] of Object.entries(expected)) {
      const create = await call(who[name] ?? name, 'POST', '/v1/workspaces/w1/items', {
        folderId: 'bugs',
        values: { title: name },
      })
      expect(create.statusCode, `create as ${name}`).toBe(status)
    }
  })

  it('refuses patch and delete without changing the item', async () => {
    for (const [who, status] of [
      ['cm', 403],
      ['agentViewer', 403],
      ['nog', 404],
      ['own', 404],
    ] as const) {
      const principal = everyone()[who] ?? who
      const patch = await call(principal, 'PATCH', '/v1/workspaces/w1/items/b1', {
        version: 1,
        values: { title: 'x' },
      })
      expect(patch.statusCode, `patch as ${who}`).toBe(status)
      const del = await call(principal, 'DELETE', '/v1/workspaces/w1/items/b1?version=1')
      expect(del.statusCode, `delete as ${who}`).toBe(status)
    }
    const item = await db
      .selectFrom('item')
      .select(['version', 'values'])
      .where('id', '=', 'b1')
      .executeTakeFirstOrThrow()
    expect(item).toEqual({ version: 1, values: { title: 'Bug' } })
  })

  it('still answers conflicts, invalid values and missing items to editors', async () => {
    const stale = await call('ed', 'PATCH', '/v1/workspaces/w1/items/b1', {
      version: 7,
      values: { title: 'x' },
    })
    expect(stale.statusCode).toBe(409)
    const invalid = await call('ed', 'PATCH', '/v1/workspaces/w1/items/b1', {
      version: 1,
      values: { title: 3 },
    })
    expect(invalid.statusCode).toBe(422)
    const missing = await call('ed', 'DELETE', '/v1/workspaces/w1/items/nope?version=1')
    expect(missing.statusCode).toBe(404)
    const patched = await call('ed', 'PATCH', '/v1/workspaces/w1/items/b1', {
      version: 1,
      values: { title: 'Fixed' },
    })
    expect(patched.statusCode).toBe(200)
    expect((await call('ed', 'DELETE', '/v1/workspaces/w1/items/b1?version=2')).statusCode).toBe(
      204,
    )
  })

  it('refuses a write into a hidden hub with 404 even to an editor elsewhere', async () => {
    const res = await call('ed', 'POST', '/v1/workspaces/w1/items', { folderId: 'docs' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ message: 'Folder not found' })
  })
})

describe('hub grants', () => {
  const url = (hub: string, principal: string) =>
    `/v1/workspaces/w1/hubs/${hub}/grants/${principal}`

  it('lets an owner grant themselves access, logged in access_log and not in revision', async () => {
    const seq = await nextLogSeq()
    const revisions = await revisionCount()
    const res = await call('own', 'PUT', url('docs', 'own'), { hubRole: 'hub_admin' })
    expect(res.statusCode).toBe(200)
    expect(hubGrantSchema.parse(res.json())).toEqual({
      workspaceId: 'w1',
      hubId: 'docs',
      principalId: 'own',
      hubRole: 'hub_admin',
    })
    expect((await call('own', 'GET', '/v1/workspaces/w1/hubs/docs')).statusCode).toBe(200)
    expect(await logSince(seq)).toEqual([
      {
        actor: 'own',
        action: 'grant.set',
        target: 'own',
        detail: { hubId: 'docs', hubRole: 'hub_admin', previous: null },
      },
    ])
    expect(await revisionCount()).toBe(revisions)
  })

  it('logs a change with the previous role, and nothing when the role is the same', async () => {
    const seq = await nextLogSeq()
    expect((await call('adm', 'PUT', url('build', 'ed'), { hubRole: 'viewer' })).statusCode).toBe(
      200,
    )
    expect((await call('adm', 'PUT', url('build', 'ed'), { hubRole: 'viewer' })).statusCode).toBe(
      200,
    )
    expect(await logSince(seq)).toEqual([
      {
        actor: 'adm',
        action: 'grant.set',
        target: 'ed',
        detail: { hubId: 'build', hubRole: 'viewer', previous: 'editor' },
      },
    ])
    const write = await call('ed', 'POST', '/v1/workspaces/w1/items', { folderId: 'bugs' })
    expect(write.statusCode).toBe(403)
  })

  it('follows the matrix for who may grant whom', async () => {
    const cases: [string, string, string, string, number][] = [
      // actor, hub, target, role, status
      ['adm', 'docs', 'adm', 'editor', 200], // admins self-grant on any hub
      ['adm', 'build', 'own2', 'viewer', 403], // admins can't touch an owner's grant
      ['own', 'build', 'own2', 'viewer', 200],
      ['nog', 'build', 'nog', 'viewer', 404], // no grant, so the hub is hidden
      ['ha', 'build', 'nog', 'hub_admin', 200], // a hub admin grants any role
      ['ha', 'build', 'ha', 'editor', 403], // but not on their own grant
      ['ha', 'build', 'adm', 'editor', 403], // nor an admin's
      ['ha', 'docs', 'nog', 'viewer', 404], // nor on a hub they can't see
      ['vw', 'build', 'nog', 'viewer', 403], // a viewer's hub_admin grant acts as viewer
      ['ed', 'build', 'nog', 'viewer', 403],
      [editorKey.secret, 'build', 'nog', 'viewer', 403],
      ['ha', 'build', viewerKey.key.id, 'editor', 403], // agent grants go with their keys
      ['own', 'build', viewerKey.key.id, 'editor', 403],
      ['ha', 'build', 'nobody', 'viewer', 404], // unknown target, to someone who may grant
      ['ed', 'build', 'nobody', 'viewer', 403], // unknown target, to someone who may not
      ['own', 'nope', 'ed', 'viewer', 404],
      ['own', 'bugs', 'ed', 'viewer', 404], // a folder is not a hub
      ['x', 'build', 'ed', 'viewer', 404], // another workspace's owner
    ]
    for (const [actor, hub, target, role, status] of cases) {
      const res = await call(actor, 'PUT', url(hub, target), { hubRole: role })
      expect(res.statusCode, `${actor} ${hub} ${target} ${role}`).toBe(status)
    }
    expect(await grantOf('docs', 'adm')).toBe('editor')
    expect(await grantOf('build', 'own2')).toBe('viewer')
    expect(await grantOf('build', 'nog')).toBe('hub_admin')
    expect(await grantOf('build', 'ha')).toBe('hub_admin')
    expect(await grantOf('build', viewerKey.key.id)).toBe('viewer')
  })

  it('rejects an invalid role and an unknown field', async () => {
    for (const body of [{ hubRole: 'owner' }, {}, { hubRole: 'viewer', extra: 1 }]) {
      const res = await call('own', 'PUT', url('build', 'ed'), body)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'invalid_request' })
    }
  })

  it('revokes, logs it, and the hub disappears for the target', async () => {
    const seq = await nextLogSeq()
    expect((await call('ha', 'DELETE', url('build', 'ed'))).statusCode).toBe(204)
    expect(await grantOf('build', 'ed')).toBeNull()
    expect((await call('ed', 'GET', '/v1/workspaces/w1/items/b1')).statusCode).toBe(404)
    // Revoking again changes and logs nothing.
    expect((await call('ha', 'DELETE', url('build', 'ed'))).statusCode).toBe(204)
    expect(await logSince(seq)).toEqual([
      {
        actor: 'ha',
        action: 'grant.revoke',
        target: 'ed',
        detail: { hubId: 'build', previous: 'editor' },
      },
    ])
  })

  it('refuses revokes the matrix forbids', async () => {
    for (const [actor, target, status] of [
      ['ha', 'ha', 403],
      ['ha', 'own2', 403],
      ['adm', 'own2', 403],
      ['vw', 'ed', 403],
      ['ed', 'cm', 403],
      ['nog', 'ed', 404],
      ['ha', viewerKey.key.id, 403],
    ] as const) {
      expect(
        (await call(actor, 'DELETE', url('build', target))).statusCode,
        `${actor} ${target}`,
      ).toBe(status)
    }
    expect(await grantOf('build', 'ha')).toBe('hub_admin')
    expect(await grantOf('build', 'own2')).toBe('hub_admin')
    expect(await grantOf('build', 'ed')).toBe('editor')
    // An owner may revoke their own grant.
    expect((await call('own2', 'DELETE', url('build', 'own2'))).statusCode).toBe(204)
  })
})

describe('creating a hub', () => {
  it('makes the creator its hub admin and logs the grant', async () => {
    const seq = await nextLogSeq()
    const res = await call('adm', 'POST', '/v1/workspaces/w1/hubs', {
      id: 'ops',
      name: ' Ops ',
      color: 'teal',
      idPrefix: 'OPS',
    })
    expect(res.statusCode).toBe(201)
    expect(hubListEntrySchema.parse(res.json())).toMatchObject({
      access: 'granted',
      hubRole: 'hub_admin',
      id: 'ops',
      hubId: 'ops',
      parentId: null,
      name: 'Ops',
      itemCount: 0,
    })
    expect(await grantOf('ops', 'adm')).toBe('hub_admin')
    expect((await call('adm', 'GET', '/v1/workspaces/w1/hubs/ops')).statusCode).toBe(200)
    expect(await logSince(seq)).toEqual([
      {
        actor: 'adm',
        action: 'grant.set',
        target: 'adm',
        detail: { hubId: 'ops', hubRole: 'hub_admin', previous: null, cause: 'hub.create' },
      },
    ])
    // Another owner sees it by name only.
    const own = hubPageSchema.parse((await call('own', 'GET', '/v1/workspaces/w1/hubs')).json())
    expect(own.items.find((h) => h.id === 'ops')).toMatchObject({ access: 'none' })
  })

  it('refuses everyone but owners and admins, a taken ID, and a bad body', async () => {
    const body = { name: 'New', color: 'teal', idPrefix: 'NEW' }
    for (const who of ['ha', 'ed', 'vw', 'fin', editorKey.secret]) {
      expect((await call(who, 'POST', '/v1/workspaces/w1/hubs', body)).statusCode, who).toBe(403)
    }
    const taken = await call('own', 'POST', '/v1/workspaces/w1/hubs', { ...body, id: 'bugs' })
    expect(taken.statusCode).toBe(409)
    expect(taken.json()).toMatchObject({ error: 'id_taken' })
    for (const bad of [
      { ...body, idPrefix: 'lower' },
      { ...body, color: '#fff' },
      { ...body, name: '  ' },
      { name: 'x' },
    ]) {
      expect((await call('own', 'POST', '/v1/workspaces/w1/hubs', bad)).statusCode).toBe(400)
    }
    const hubs = await db.selectFrom('folder').select('id').where('parent_id', 'is', null).execute()
    expect(hubs.map((h) => h.id).sort()).toEqual(['build', 'docs', 'secret'])
  })

  it('gives a server-made ID when none is sent', async () => {
    const res = await call('own', 'POST', '/v1/workspaces/w1/hubs', {
      name: 'Auto',
      color: 'red',
      idPrefix: 'AU',
    })
    expect(res.statusCode).toBe(201)
    const { id } = res.json<{ id: string }>()
    expect(await grantOf(id, 'own')).toBe('hub_admin')
  })
})

describe('members', () => {
  const memberUrl = (id: string) => `/v1/workspaces/w1/members/${id}`

  it('lists people by name with paging, never agents, and refuses agents', async () => {
    const res = await call('nog', 'GET', '/v1/workspaces/w1/members?limit=4')
    expect(res.statusCode).toBe(200)
    const first = memberPageSchema.parse(res.json())
    expect(first.items.map((m) => m.id)).toEqual(['adm', 'cm', 'ed', 'fin'])
    const rest = memberPageSchema.parse(
      (
        await call('nog', 'GET', `/v1/workspaces/w1/members?cursor=${String(first.nextCursor)}`)
      ).json(),
    )
    expect(rest.items.map((m) => m.id)).toEqual(['ha', 'nog', 'own', 'own2', 'vw'])
    expect(rest.nextCursor).toBeNull()
    expect((await call(editorKey.secret, 'GET', '/v1/workspaces/w1/members')).statusCode).toBe(403)
    expect((await call('nog', 'GET', '/v1/workspaces/w1/members?limit=0')).statusCode).toBe(400)
  })

  it('changes roles following the matrix, logging each change', async () => {
    const seq = await nextLogSeq()
    const cases: [string, string, string, number][] = [
      ['adm', 'ed', 'viewer', 200],
      ['adm', 'ed', 'viewer', 200], // same role: no log entry
      ['adm', 'ed', 'owner', 403], // admins can't make owners
      ['adm', 'own', 'member', 403], // or change one
      ['ha', 'ed', 'member', 403],
      ['vw', 'ed', 'member', 403],
      [editorKey.secret, 'ed', 'member', 403],
      ['own', viewerKey.key.id, 'admin', 403], // agents are managed through keys
      ['own', 'nobody', 'admin', 404],
      ['own', 'adm', 'owner', 200],
    ]
    for (const [actor, target, role, status] of cases) {
      const res = await call(actor, 'PATCH', memberUrl(target), { workspaceRole: role })
      expect(res.statusCode, `${actor} ${target} ${role}`).toBe(status)
      if (status === 200) expect(principalSchema.parse(res.json()).workspaceRole).toBe(role)
    }
    expect(await logSince(seq)).toEqual([
      {
        actor: 'adm',
        action: 'member.role',
        target: 'ed',
        detail: { from: 'member', to: 'viewer' },
      },
      {
        actor: 'own',
        action: 'member.role',
        target: 'adm',
        detail: { from: 'admin', to: 'owner' },
      },
    ])
    // The viewer cap applies at once: ed's editor grant now acts as viewer.
    const write = await call('ed', 'POST', '/v1/workspaces/w1/items', { folderId: 'bugs' })
    expect(write.statusCode).toBe(403)
    expect(
      (await call('own', 'PATCH', memberUrl('ed'), { workspaceRole: 'boss' })).statusCode,
    ).toBe(400)
  })

  it('always keeps one owner, even when two owners demote each other at once', async () => {
    const [a, b] = await Promise.all([
      call('own', 'PATCH', memberUrl('own2'), { workspaceRole: 'member' }),
      call('own2', 'PATCH', memberUrl('own'), { workspaceRole: 'member' }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403])
    const owners = await db
      .selectFrom('principal')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('workspace_role', '=', 'owner')
      .execute()
    expect(owners).toHaveLength(1)
    const last = owners[0]?.id ?? ''
    expect(
      (await call(last, 'PATCH', memberUrl(last), { workspaceRole: 'admin' })).statusCode,
    ).toBe(403)
    expect((await call(last, 'DELETE', memberUrl(last))).statusCode).toBe(403)
  })

  it('refuses removals the matrix forbids', async () => {
    for (const [actor, target, status] of [
      ['adm', 'own', 403],
      ['ha', 'ed', 403],
      ['vw', 'ed', 403],
      [editorKey.secret, 'ed', 403],
      ['own', viewerKey.key.id, 403],
      ['own', 'nobody', 404],
      ['x', 'ed', 404], // another workspace's owner can't even see w1
    ] as const) {
      expect(
        (await call(actor, 'DELETE', memberUrl(target))).statusCode,
        `${actor} ${target}`,
      ).toBe(status)
    }
    const removed = await db
      .selectFrom('principal')
      .select('id')
      .where('removed_at', 'is not', null)
      .execute()
    expect(removed).toEqual([])
  })
})

describe('removing a member', () => {
  /** The token of a live session for `principalId`. */
  async function signIn(principalId: string): Promise<string> {
    return (await as(principalId)).cookie.slice(`${SESSION_COOKIE}=`.length)
  }

  const withSession = (session: string, method: Method, url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
      payload,
    })

  it('deactivates the principal: no access, no grants, history keeps its actor', async () => {
    const session = await signIn('ed')
    const write = await withSession(session, 'POST', '/v1/workspaces/w1/items', {
      folderId: 'bugs',
      values: { title: 'by ed' },
    })
    expect(write.statusCode).toBe(201)
    const itemId = write.json<{ id: string }>().id
    const revisions = await revisionCount()
    const seq = await nextLogSeq()

    expect((await call('adm', 'DELETE', '/v1/workspaces/w1/members/ed')).statusCode).toBe(204)

    // The session still works, but no longer reaches the workspace.
    const me = meSchema.parse((await withSession(session, 'GET', '/v1/me')).json())
    expect(me.kind === 'person' && me.memberships).toEqual([])
    for (const url of ['/v1/workspaces/w1/hubs', `/v1/workspaces/w1/items/${itemId}`]) {
      expect((await withSession(session, 'GET', url)).statusCode, url).toBe(404)
    }
    // Nor through any other session of theirs: a removed principal is never linked again.
    expect((await call('ed', 'GET', '/v1/workspaces/w1/hubs')).statusCode).toBe(404)
    expect((await call('ed', 'GET', '/v1/workspaces')).json<{ items: unknown[] }>().items).toEqual(
      [],
    )

    const row = await db
      .selectFrom('principal')
      .select(['account_id', 'removed_at', 'workspace_role'])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'ed')
      .executeTakeFirstOrThrow()
    expect(row.account_id).toBeNull()
    expect(row.removed_at).toBeInstanceOf(Date)
    expect(await grantOf('build', 'ed')).toBeNull()
    expect(await revisionCount()).toBe(revisions)
    const item = await call('ha', 'GET', `/v1/workspaces/w1/items/${itemId}`)
    expect(item.json()).toMatchObject({ updatedBy: 'ed' })
    expect(await logSince(seq)).toEqual([
      {
        actor: 'adm',
        action: 'member.remove',
        target: 'ed',
        detail: {
          workspaceRole: 'member',
          accountId: 'acct-ed',
          revokedGrants: [{ hubId: 'build', hubRole: 'editor' }],
          expiredInvites: [],
        },
      },
    ])

    // Gone from the member list, and can't be removed, changed or granted again.
    const members = memberPageSchema.parse(
      (await call('ha', 'GET', '/v1/workspaces/w1/members')).json(),
    )
    expect(members.items.map((m) => m.id)).not.toContain('ed')
    expect((await call('adm', 'DELETE', '/v1/workspaces/w1/members/ed')).statusCode).toBe(404)
    expect(
      (await call('adm', 'PATCH', '/v1/workspaces/w1/members/ed', { workspaceRole: 'admin' }))
        .statusCode,
    ).toBe(404)
    expect(
      (await call('ha', 'PUT', '/v1/workspaces/w1/hubs/build/grants/ed', { hubRole: 'viewer' }))
        .statusCode,
    ).toBe(404)
  })

  it('expires the removed member’s unused invites, keeps their agent keys, and allows a re-invite', async () => {
    const adminSession = await signIn('adm')
    const invite = await call('adm', 'POST', '/v1/workspaces/w1/invites', {
      workspaceRole: 'member',
    })
    expect(invite.statusCode).toBe(201)
    const token = invite.json<{ token: string }>().token
    await call('adm', 'PUT', '/v1/workspaces/w1/hubs/build/grants/adm', { hubRole: 'hub_admin' })
    const key = await call('adm', 'POST', '/v1/workspaces/w1/hubs/build/agent-keys', {
      name: 'adm bot',
      hubRole: 'viewer',
    })
    expect(key.statusCode).toBe(201)

    expect((await call('own', 'DELETE', '/v1/workspaces/w1/members/adm')).statusCode).toBe(204)

    const [entry] = await db
      .selectFrom('access_log')
      .select('detail')
      .where('action', '=', 'member.remove')
      .execute()
    expect(entry?.detail).toMatchObject({
      revokedGrants: [{ hubId: 'build', hubRole: 'hub_admin' }],
      expiredInvites: [invite.json<{ invite: { id: string } }>().invite.id],
    })
    const redeem = await app.inject({
      method: 'POST',
      url: `/v1/auth/invites/${token}`,
      payload: { name: 'Sneaky', email: 'sneaky@example.com', password: 'long enough password' },
    })
    expect(redeem.statusCode).toBe(404)
    // Their key stays until someone revokes it (docs/ROLES.md).
    const secret = key.json<CreatedAgentKey>().secret
    expect((await call(secret, 'GET', '/v1/workspaces/w1/hubs')).statusCode).toBe(200)

    // A new invite brings the same account back as a new principal.
    const again = await call('own', 'POST', '/v1/workspaces/w1/invites', {
      workspaceRole: 'viewer',
    })
    const back = await withSession(
      adminSession,
      'POST',
      `/v1/auth/invites/${again.json<{ token: string }>().token}`,
      {},
    )
    expect(back.statusCode).toBe(201)
    const { principalId } = back.json<{ principalId: string }>()
    expect(principalId).not.toBe('adm')
    const hubs = await withSession(adminSession, 'GET', '/v1/workspaces/w1/hubs')
    expect(hubs.statusCode).toBe(200)
    // No grant carried over.
    expect(hubPageSchema.parse(hubs.json()).items).toEqual([])
  })

  // An admin can't end an owner-role invite (footnote 1, migration 0010), except as part of
  // removing its creator: here an owner who invited an owner and was then demoted (#130).
  it('expires an owner-role invite when an admin removes its demoted creator', async () => {
    const invite = await call('own2', 'POST', '/v1/workspaces/w1/invites', {
      workspaceRole: 'owner',
    })
    expect(invite.statusCode).toBe(201)
    const inviteId = invite.json<{ invite: { id: string } }>().invite.id
    const demoted = await call('own', 'PATCH', '/v1/workspaces/w1/members/own2', {
      workspaceRole: 'admin',
    })
    expect(demoted.statusCode).toBe(200)

    expect((await call('adm', 'DELETE', '/v1/workspaces/w1/members/own2')).statusCode).toBe(204)

    const row = await db
      .selectFrom('invite')
      .select(['used_at', sql<boolean>`expires_at = created_at`.as('ended')])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', inviteId)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ used_at: null, ended: true })
    const [entry] = await db
      .selectFrom('access_log')
      .select('detail')
      .where('action', '=', 'member.remove')
      .execute()
    expect(entry?.detail).toMatchObject({ expiredInvites: [inviteId] })
    const redeem = await app.inject({
      method: 'POST',
      url: `/v1/auth/invites/${invite.json<{ token: string }>().token}`,
      payload: { name: 'Late', email: 'late@example.com', password: 'long enough password' },
    })
    expect(redeem.statusCode).toBe(404)
  })

  it('keeps the database from linking a removed principal to an account', async () => {
    await call('own', 'DELETE', '/v1/workspaces/w1/members/nog')
    await db
      .insertInto('account')
      .values({ id: 'acc-x', email: 'x@example.com', password_hash: '$argon2id$x', name: 'x' })
      .execute()
    await expect(
      db
        .updateTable('principal')
        .set({ account_id: 'acc-x' })
        .where('workspace_id', '=', 'w1')
        .where('id', '=', 'nog')
        .execute(),
    ).rejects.toThrow(/principal_removed_check/)
  })
})
