import {
  apiErrorSchema,
  changesPageSchema,
  createdAgentKeySchema,
  itemQueryResultSchema,
  itemReadSchema,
  itemWriteResultSchema,
  revisionPageSchema,
  type HubRole,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'
import { lockHubSchema } from './schema-lock.ts'

// External keys (D64, #200): set and cleared on create and patch, read by key, and upsert by
// key, per role, with `clientMutationId` (D59) and `cause` (D63), and the races on a key.
// Against a real Postgres under row-level security.

const WS = 'w1'

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
const cookies = new Map<string, string>()
const PEOPLE = ['own', 'ed', 'vw', 'none'] as const

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  for (const p of PEOPLE) cookies.set(p, (await sessionCookie(db, p)).cookie)
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * Hub h1 with a folder f1, both showing text attribute t1; hub h2 with t2. `own` (owner) is hub
 * admin of both, `ed` an editor of both, `vw` a viewer of h1 only, `none` a member with no grant.
 */
async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: WS, name: 'W' }).execute()
  await db
    .insertInto('principal')
    .values(
      PEOPLE.map((id) => ({
        workspace_id: WS,
        id,
        kind: 'user' as const,
        name: id,
        workspace_role: id === 'own' ? ('owner' as const) : ('member' as const),
      })),
    )
    .execute()
  const folder = (id: string, hub: string, prefix: string) => ({
    workspace_id: WS,
    id,
    hub_id: hub,
    parent_id: id === hub ? null : hub,
    name: id,
    color: 'blue',
    id_prefix: prefix,
  })
  await db
    .insertInto('folder')
    .values([folder('h1', 'h1', 'ONE'), folder('h2', 'h2', 'TWO')])
    .execute()
  await db
    .insertInto('folder')
    .values(folder('f1', 'h1', 'ONE'))
    .execute()
  await db
    .insertInto('attribute')
    .values(
      (['h1', 'h2'] as const).map((hub) => ({
        workspace_id: WS,
        id: hub === 'h1' ? 't1' : 't2',
        hub_id: hub,
        name: 'T',
        type: 'text' as const,
        config: '{}',
      })),
    )
    .execute()
  await db
    .insertInto('folder_attribute')
    .values(
      [
        ['h1', 'h1', 't1'],
        ['h1', 'f1', 't1'],
        ['h2', 'h2', 't2'],
      ].map(([hub, folderId, attribute]) => ({
        workspace_id: WS,
        hub_id: hub as string,
        folder_id: folderId as string,
        attribute_id: attribute as string,
        position: 0,
      })),
    )
    .execute()
  const grant = (hub: string, principal: string, role: HubRole) => ({
    workspace_id: WS,
    hub_id: hub,
    principal_id: principal,
    hub_role: role,
  })
  await db
    .insertInto('hub_grant')
    .values([
      grant('h1', 'own', 'hub_admin'),
      grant('h2', 'own', 'hub_admin'),
      grant('h1', 'ed', 'editor'),
      grant('h2', 'ed', 'editor'),
      grant('h1', 'vw', 'viewer'),
    ])
    .execute()
}

const as = (who: string, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url: `/v1/workspaces/${WS}${url}`,
    headers: { cookie: cookies.get(who) ?? '' },
    ...(payload !== undefined && { payload }),
  })

const byKey = (hub: string, key: string) => `/hubs/${hub}/items/by-key/${encodeURIComponent(key)}`

const upsert = (who: string, hub: string, key: string, body: object) =>
  as(who, 'PUT', byKey(hub, key), body)

const errorOf = (body: unknown) => apiErrorSchema.parse(body)

async function create(who: string, body: object) {
  const res = await as(who, 'POST', '/items', body)
  expect(res.statusCode, res.body).toBe(201)
  return itemWriteResultSchema.parse(res.json())
}

async function history(itemId: string) {
  const res = await as('own', 'GET', `/items/${itemId}/revisions`)
  expect(res.statusCode, res.body).toBe(200)
  return revisionPageSchema.parse(res.json()).items.map((r) => r.patch)
}

const itemRows = () =>
  db
    .selectFrom('item')
    .select(['id', 'folder_id', 'external_key', 'version', 'values'])
    .where('workspace_id', '=', WS)
    .orderBy('seq_id')
    .execute()

describe('externalKey on create and patch', () => {
  it('sets, changes and clears the key, and shows it in reads, queries, changes and history', async () => {
    const keyed = await create('ed', {
      folderId: 'f1',
      externalKey: 'src/app.ts',
      values: { t1: 'a' },
    })
    expect(keyed.externalKey).toBe('src/app.ts')
    const plain = await create('ed', { folderId: 'h1', values: { t1: 'b' } })
    expect(plain).not.toHaveProperty('externalKey')

    const read = await as('vw', 'GET', `/items/${keyed.id}`)
    expect(itemReadSchema.parse(read.json()).externalKey).toBe('src/app.ts')
    const query = await as('vw', 'POST', '/query', { from: 'f1', limit: 10 })
    expect(itemQueryResultSchema.parse(query.json()).items[0]?.externalKey).toBe('src/app.ts')

    // A key-only patch is a write: a revision with empty values.
    const changed = await as('ed', 'PATCH', `/items/${keyed.id}`, {
      version: 1,
      externalKey: 'src/main.ts',
    })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(itemWriteResultSchema.parse(changed.json())).toMatchObject({
      version: 2,
      externalKey: 'src/main.ts',
      values: { t1: 'a' },
    })
    expect((await as('vw', 'GET', byKey('h1', 'src/app.ts'))).statusCode).toBe(404)
    expect((await as('vw', 'GET', byKey('h1', 'src/main.ts'))).statusCode).toBe(200)

    const cleared = await as('ed', 'PATCH', `/items/${keyed.id}`, {
      version: 2,
      externalKey: null,
      values: { t1: 'c' },
    })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(cleared.json()).not.toHaveProperty('externalKey')
    expect((await as('vw', 'GET', byKey('h1', 'src/main.ts'))).statusCode).toBe(404)

    // A value-only patch leaves the key alone and does not record it.
    const relabel = await create('ed', { folderId: 'h1', externalKey: 'k', values: {} })
    const kept = await as('ed', 'PATCH', `/items/${relabel.id}`, {
      version: 1,
      values: { t1: 'z' },
    })
    expect(kept.json()).toMatchObject({ externalKey: 'k' })

    expect(await history(keyed.id)).toEqual([
      { op: 'update', externalKey: null, values: { t1: 'c' } },
      { op: 'update', externalKey: 'src/main.ts', values: {} },
      { op: 'create', folderId: 'f1', externalKey: 'src/app.ts', values: { t1: 'a' } },
    ])
    expect(await history(relabel.id)).toEqual([
      { op: 'update', values: { t1: 'z' } },
      { op: 'create', folderId: 'h1', externalKey: 'k', values: {} },
    ])

    const page = changesPageSchema.parse((await as('vw', 'GET', '/changes?after=0')).json())
    const latest = new Map(page.changes.map((c) => [c.itemId, c.item]))
    expect(latest.get(keyed.id)).not.toHaveProperty('externalKey')
    expect(latest.get(relabel.id)?.externalKey).toBe('k')
  })

  it('answers 409 key_taken for a key another item of the hub holds, and writes nothing', async () => {
    const holder = await create('ed', { folderId: 'h1', externalKey: 'K', values: {} })
    const other = await create('ed', { folderId: 'f1', values: {} })
    const before = await workspaceSnapshot(db, WS)
    for (const res of [
      // Another folder of the same hub: keys are unique per hub.
      await as('ed', 'POST', '/items', { folderId: 'f1', externalKey: 'K', values: {} }),
      await as('ed', 'PATCH', `/items/${other.id}`, { version: 1, externalKey: 'K' }),
    ]) {
      expect(res.statusCode, res.body).toBe(409)
      expect(errorOf(res.json()).error).toBe('key_taken')
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)

    // Setting an item's own key again is fine; keys compare exactly; other hubs are separate.
    const same = await as('ed', 'PATCH', `/items/${holder.id}`, { version: 1, externalKey: 'K' })
    expect(same.statusCode, same.body).toBe(200)
    await create('ed', { folderId: 'h1', externalKey: 'k', values: {} })
    await create('ed', { folderId: 'h2', externalKey: 'K', values: {} })
    // A cleared key is free again.
    await as('ed', 'PATCH', `/items/${holder.id}`, { version: 2, externalKey: null })
    await create('ed', { folderId: 'f1', externalKey: 'K', values: {} })
  })

  it('refuses invalid keys with 400 and writes nothing', async () => {
    const item = await create('ed', { folderId: 'h1', values: {} })
    const before = await workspaceSnapshot(db, WS)
    for (const externalKey of ['', ' lead', 'trail\n', 'a\u0007b', 'x'.repeat(201)]) {
      for (const res of [
        await as('ed', 'POST', '/items', { folderId: 'h1', externalKey, values: {} }),
        await as('ed', 'PATCH', `/items/${item.id}`, { version: 1, externalKey }),
      ]) {
        expect(res.statusCode, `${JSON.stringify(externalKey)}: ${res.body}`).toBe(400)
        expect(errorOf(res.json()).error).toBe('invalid_request')
      }
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })
})

describe('GET by key', () => {
  it('reads the item for anyone who can read the hub, with seq and expand', async () => {
    const item = await create('ed', { folderId: 'f1', externalKey: 'T-1', values: { t1: 'a' } })
    for (const who of ['own', 'ed', 'vw']) {
      const res = await as(who, 'GET', byKey('h1', 'T-1'))
      expect(res.statusCode, res.body).toBe(200)
      const read = itemReadSchema.parse(res.json())
      expect(read).toMatchObject({ id: item.id, externalKey: 'T-1', folderId: 'f1' })
      expect(read.seq).toBeGreaterThanOrEqual(item.seq)
    }
    // `expand` is checked as for GET /items/:itemId.
    const bad = await as('vw', 'GET', `${byKey('h1', 'T-1')}?expand=nope`)
    expect(bad.statusCode, bad.body).toBe(400)
  })

  it('answers 404 alike for a missing key, a hidden hub and a missing hub', async () => {
    await create('ed', { folderId: 'h1', externalKey: 'T-1', values: {} })
    await create('ed', { folderId: 'h2', externalKey: 'T-2', values: {} })
    const missing = [
      await as('vw', 'GET', byKey('h1', 'T-2')),
      await as('vw', 'GET', byKey('h2', 'T-2')),
      await as('none', 'GET', byKey('h1', 'T-1')),
      await as('own', 'GET', byKey('nope', 'T-1')),
    ]
    for (const res of missing) {
      expect(res.statusCode, res.body).toBe(404)
      expect(errorOf(res.json()).error).toBe('not_found')
    }
    expect((await as('vw', 'GET', byKey('h1', ' x'))).statusCode).toBe(400)
  })
})

describe('PUT by key (upsert)', () => {
  it('creates with 201, then patches with 200 where the item is, last write wins', async () => {
    const created = await upsert('ed', 'h1', 'src/app.ts', {
      folderId: 'f1',
      values: { t1: 'a' },
      cause: { note: 'first sync' },
    })
    expect(created.statusCode, created.body).toBe(201)
    const first = itemWriteResultSchema.parse(created.json())
    expect(first).toMatchObject({
      folderId: 'f1',
      externalKey: 'src/app.ts',
      version: 1,
      values: { t1: 'a' },
    })

    // Another folder of the hub: the item is patched in its own folder (D64).
    const patched = await upsert('own', 'h1', 'src/app.ts', {
      folderId: 'h1',
      values: { t1: 'b' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(itemWriteResultSchema.parse(patched.json())).toMatchObject({
      id: first.id,
      folderId: 'f1',
      version: 2,
      values: { t1: 'b' },
      updatedBy: 'own',
    })
    // With a version: a stale one is 409 conflict, the current one patches.
    const stale = await upsert('ed', 'h1', 'src/app.ts', {
      folderId: 'f1',
      version: 1,
      values: { t1: 'c' },
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'conflict', current: { version: 2 } })
    const current = await upsert('ed', 'h1', 'src/app.ts', {
      folderId: 'f1',
      version: 2,
      values: { t1: null },
    })
    expect(current.statusCode, current.body).toBe(200)
    expect(current.json()).toMatchObject({ version: 3, values: {} })

    const revisions = await as('own', 'GET', `/items/${first.id}/revisions`)
    const entries = revisionPageSchema.parse(revisions.json()).items
    expect(entries.map((e) => [e.patch, e.cause])).toEqual([
      [{ op: 'update', values: { t1: null } }, null],
      [{ op: 'update', values: { t1: 'b' } }, null],
      [
        { op: 'create', folderId: 'f1', externalKey: 'src/app.ts', values: { t1: 'a' } },
        { note: 'first sync' },
      ],
    ])
    const counts = await db
      .selectFrom('folder')
      .select(['id', 'item_count'])
      .where('workspace_id', '=', WS)
      .orderBy('id')
      .execute()
    expect(counts).toEqual([
      { id: 'f1', item_count: 1 },
      { id: 'h1', item_count: 1 },
      { id: 'h2', item_count: 0 },
    ])
  })

  it('writes no revision for empty values on an existing item', async () => {
    await upsert('ed', 'h1', 'k', { folderId: 'h1', values: { t1: 'a' } })
    const before = await workspaceSnapshot(db, WS)
    const res = await upsert('ed', 'h1', 'k', { folderId: 'h1' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ version: 1, values: { t1: 'a' } })
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
    // Still checks the version.
    const stale = await upsert('ed', 'h1', 'k', { folderId: 'h1', version: 7 })
    expect(stale.statusCode).toBe(409)
  })

  it('answers 404 for a version with no item, and a folder outside the hub on either path', async () => {
    await upsert('ed', 'h1', 'held', { folderId: 'h1', values: {} })
    const before = await workspaceSnapshot(db, WS)
    for (const [key, body] of [
      ['new', { folderId: 'h1', version: 1, values: { t1: 'x' } }],
      ['new', { folderId: 'h2', values: {} }],
      ['new', { folderId: 'missing', values: {} }],
      ['held', { folderId: 'h2', values: { t1: 'x' } }],
      ['held', { folderId: 'missing', values: { t1: 'x' } }],
    ] as const) {
      const res = await upsert('ed', 'h1', key, body)
      expect(res.statusCode, `${key} ${JSON.stringify(body)}: ${res.body}`).toBe(404)
      expect(errorOf(res.json()).error).toBe('not_found')
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('checks values and the body as create and patch do', async () => {
    await upsert('ed', 'h1', 'held', { folderId: 'h1', values: {} })
    const before = await workspaceSnapshot(db, WS)
    for (const key of ['new', 'held']) {
      const invalid = await upsert('ed', 'h1', key, { folderId: 'h1', values: { t1: 42 } })
      expect(invalid.statusCode, invalid.body).toBe(422)
      expect(errorOf(invalid.json()).error).toBe('invalid_values')
      const extra = await upsert('ed', 'h1', key, { folderId: 'h1', values: {}, externalKey: 'x' })
      expect(extra.statusCode, extra.body).toBe(400)
    }
    expect((await upsert('ed', 'h1', 'x'.repeat(201), { folderId: 'h1' })).statusCode).toBe(400)
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('answers per role: 403 for a viewer, 404 without a grant (D45)', async () => {
    await upsert('ed', 'h1', 'held', { folderId: 'h1', values: {} })
    const before = await workspaceSnapshot(db, WS)
    for (const key of ['new', 'held']) {
      const viewer = await upsert('vw', 'h1', key, { folderId: 'h1', values: { t1: 'x' } })
      expect(viewer.statusCode, viewer.body).toBe(403)
      // `vw` cannot see h2, `none` sees no hub: alike for a missing hub.
      for (const [who, hub] of [
        ['vw', 'h2'],
        ['none', 'h1'],
        ['own', 'nope'],
      ] as const) {
        const hidden = await upsert(who, hub, key, { folderId: hub, values: {} })
        expect(hidden.statusCode, `${who} ${hub}: ${hidden.body}`).toBe(404)
        expect(errorOf(hidden.json()).error).toBe('not_found')
      }
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('lets an agent key read and upsert in its one hub only (D47)', async () => {
    await create('ed', { folderId: 'h2', externalKey: 'other', values: {} })
    const key = async (hubRole: HubRole) => {
      const res = await as('own', 'POST', '/hubs/h1/agent-keys', { name: 'bot', hubRole })
      expect(res.statusCode, res.body).toBe(201)
      const { secret } = createdAgentKeySchema.parse(res.json())
      return (method: string, url: string, payload?: object) =>
        app.inject({
          method: method as 'GET',
          url: `/v1/workspaces/${WS}${url}`,
          headers: { authorization: `Bearer ${secret}` },
          ...(payload !== undefined && { payload }),
        })
    }
    const editor = await key('editor')
    const made = await editor('PUT', byKey('h1', 'a/1'), { folderId: 'f1', values: { t1: 'x' } })
    expect(made.statusCode, made.body).toBe(201)
    const again = await editor('PUT', byKey('h1', 'a/1'), { folderId: 'f1', values: { t1: 'y' } })
    expect(again.statusCode, again.body).toBe(200)
    expect((await editor('GET', byKey('h1', 'a/1'))).json()).toMatchObject({ values: { t1: 'y' } })
    for (const res of [
      await editor('GET', byKey('h2', 'other')),
      await editor('PUT', byKey('h2', 'other'), { folderId: 'h2', values: {} }),
      await editor('PUT', byKey('h2', 'new'), { folderId: 'h2', values: {} }),
      // Its own hub, with a folder of another hub.
      await editor('PUT', byKey('h1', 'new'), { folderId: 'h2', values: {} }),
    ]) {
      expect(res.statusCode, res.body).toBe(404)
    }

    const viewer = await key('viewer')
    expect((await viewer('GET', byKey('h1', 'a/1'))).statusCode).toBe(200)
    const refused = await viewer('PUT', byKey('h1', 'a/1'), { folderId: 'f1', values: {} })
    expect(refused.statusCode, refused.body).toBe(403)
  })

  describe('clientMutationId (D59)', () => {
    const ID = '0b9d8a3c-4b7e-4f3a-9a52-1c2d3e4f5a6b'

    it('answers a retry as the first attempt did, 201 or 200, writing nothing', async () => {
      const body = { folderId: 'h1', values: { t1: 'a' }, clientMutationId: ID }
      const first = await upsert('ed', 'h1', 'k', body)
      expect(first.statusCode, first.body).toBe(201)
      // Changed since by someone else: the retry answers with the item as it is now.
      await upsert('own', 'h1', 'k', { folderId: 'h1', values: { t1: 'b' } })
      const before = await workspaceSnapshot(db, WS)
      const retry = await upsert('ed', 'h1', 'k', body)
      expect(retry.statusCode, retry.body).toBe(201)
      expect(retry.json()).toMatchObject({ version: 2, values: { t1: 'b' } })
      expect(await workspaceSnapshot(db, WS)).toEqual(before)

      const ID2 = '1b9d8a3c-4b7e-4f3a-9a52-1c2d3e4f5a6b'
      const patch = { folderId: 'h1', values: { t1: 'c' }, clientMutationId: ID2 }
      expect((await upsert('ed', 'h1', 'k', patch)).statusCode).toBe(200)
      const again = await upsert('ed', 'h1', 'k', patch)
      expect(again.statusCode, again.body).toBe(200)
      expect(again.json()).toMatchObject({ version: 3 })
      expect((await itemRows())[0]?.version).toBe(3)
    })

    it('refuses the ID with another key, folder or operation (422)', async () => {
      await create('ed', { folderId: 'h1', externalKey: 'other', values: {} })
      const body = { folderId: 'h1', values: { t1: 'a' }, clientMutationId: ID }
      expect((await upsert('ed', 'h1', 'k', body)).statusCode).toBe(201)
      const item = (await itemRows()).find((r) => r.external_key === 'k')
      for (const res of [
        await upsert('ed', 'h1', 'other', body),
        await upsert('ed', 'h1', 'new', body),
        await upsert('ed', 'h1', 'k', { ...body, folderId: 'f1' }),
        await upsert('ed', 'h2', 'k', { ...body, folderId: 'h2', values: {} }),
        await as('ed', 'PATCH', `/items/${item?.id ?? ''}`, {
          version: 1,
          values: {},
          externalKey: 'k2',
          clientMutationId: ID,
        }),
      ]) {
        expect(res.statusCode, res.body).toBe(422)
        expect(errorOf(res.json()).error).toBe('mutation_id_reused')
      }
      // An upsert's ID used first by a plain patch of the item holding the key is its own.
      const ID3 = '2b9d8a3c-4b7e-4f3a-9a52-1c2d3e4f5a6b'
      const patched = await as('ed', 'PATCH', `/items/${item?.id ?? ''}`, {
        version: 1,
        values: { t1: 'p' },
        clientMutationId: ID3,
      })
      expect(patched.statusCode, patched.body).toBe(200)
      const replay = await upsert('ed', 'h1', 'k', { ...body, clientMutationId: ID3 })
      expect(replay.statusCode, replay.body).toBe(200)
      expect(replay.json()).toMatchObject({ version: 2, values: { t1: 'p' } })
    })
  })
})

describe('races on a key', () => {
  /** Holds what `lock` takes, as the owner, until the returned function is called. */
  async function holding(lock: (trx: Transaction<Database>) => Promise<unknown>) {
    let release = () => {}
    let locked = () => {}
    const ready = new Promise<void>((done) => (locked = done))
    const released = new Promise<void>((done) => (release = done))
    const done = db.transaction().execute(async (trx) => {
      await lock(trx)
      locked()
      await released
    })
    await ready
    return async () => {
      release()
      await done
    }
  }

  /** Waits until `n` backends of this database wait on a lock. */
  async function waiting(n: number) {
    for (let i = 0; i < 500; i++) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `.execute(db)
      if ((rows[0]?.n ?? 0) >= n) return
      await new Promise((done) => setTimeout(done, 10))
    }
    throw new Error(`fewer than ${String(n)} waiting backends`)
  }

  /** Holds the hub row, which every create takes after looking the key up. */
  const holdHub = () =>
    holding((trx) =>
      trx.selectFrom('folder').select('id').where('id', '=', 'h1').forUpdate().execute(),
    )

  it('two upserts of a new key create one item; the loser patches it', async () => {
    const release = await holdHub()
    const racing = [
      upsert('ed', 'h1', 'new', { folderId: 'h1', values: { t1: 'a' } }),
      upsert('own', 'h1', 'new', { folderId: 'f1', values: { t1: 'b' } }),
    ]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 201])
    const rows = await itemRows()
    expect(rows).toHaveLength(1)
    const [created] = answers.filter((r) => r.statusCode === 201).map((r) => r.json<object>())
    const [patched] = answers.filter((r) => r.statusCode === 200).map((r) => r.json<object>())
    expect(patched).toMatchObject({
      version: 2,
      folderId: (created as { folderId: string }).folderId,
    })
    expect(rows[0]?.version).toBe(2)
    const ops = (await history(rows[0]?.id ?? '')).map((p) => p.op)
    expect(ops).toEqual(['update', 'create'])
    const hub = await db.selectFrom('folder').select('item_count').where('id', '=', 'h1').execute()
    expect(hub[0]?.item_count).toBe(1)
  })

  it('a retry racing its first attempt answers 201 as the first did, with one revision', async () => {
    const body = {
      folderId: 'h1',
      values: { t1: 'a' },
      clientMutationId: '3b9d8a3c-4b7e-4f3a-9a52-1c2d3e4f5a6b',
    }
    const release = await holdHub()
    const racing = [upsert('ed', 'h1', 'new', body), upsert('ed', 'h1', 'new', body)]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(answers.map((r) => r.statusCode)).toEqual([201, 201])
    expect(answers.map((r) => r.json<{ version: number }>().version)).toEqual([1, 1])
    const rows = await itemRows()
    expect(rows).toHaveLength(1)
    expect(await history(rows[0]?.id ?? '')).toHaveLength(1)
  })

  it('two plain creates of one key: one 201, one 409 key_taken', async () => {
    const release = await holdHub()
    const racing = [
      as('ed', 'POST', '/items', { folderId: 'h1', externalKey: 'k', values: {} }),
      as('ed', 'POST', '/items', { folderId: 'f1', externalKey: 'k', values: {} }),
    ]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(answers.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(answers.find((r) => r.statusCode === 409)?.json()).toMatchObject({ error: 'key_taken' })
    expect(await itemRows()).toHaveLength(1)
  })

  it('an upsert whose item is deleted after the lookup creates a new one', async () => {
    const old = await create('ed', { folderId: 'h1', externalKey: 'k', values: { t1: 'old' } })
    // The patch path takes the hub's schema lock after finding the item, before locking it.
    const release = await holding((trx) => lockHubSchema(trx, WS, 'h1', 'exclusive'))
    const racing = upsert('own', 'h1', 'k', { folderId: 'f1', values: { t1: 'new' } })
    await waiting(1)
    const deleted = await as('ed', 'DELETE', `/items/${old.id}?version=1`)
    expect(deleted.statusCode, deleted.body).toBe(204)
    await release()
    const res = await racing
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ folderId: 'f1', externalKey: 'k', values: { t1: 'new' } })
    expect(res.json<{ id: string }>().id).not.toBe(old.id)
  })

  it('an upsert whose item gives the key away after the lookup patches its new holder', async () => {
    const a = await create('ed', { folderId: 'h1', externalKey: 'k', values: { t1: 'a' } })
    const b = await create('ed', { folderId: 'h1', values: { t1: 'b' } })
    const release = await holding((trx) => lockHubSchema(trx, WS, 'h1', 'exclusive'))
    const racing = upsert('own', 'h1', 'k', { folderId: 'h1', values: { t1: 'won' } })
    await waiting(1)
    // A key-only patch takes the schema lock too, so the move runs as the owner, outside it.
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('item').set({ external_key: null }).where('id', '=', a.id).execute()
      await trx.updateTable('item').set({ external_key: 'k' }).where('id', '=', b.id).execute()
    })
    await release()
    const res = await racing
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ id: b.id, values: { t1: 'won' } })
  })
})

describe('keys in the URL path', () => {
  const KEYS = [
    'src/app.ts',
    'a//b/',
    '100%',
    '%2F',
    'what?x=1',
    'issue#12',
    'a;b',
    '+ & =',
    'café ✓',
    '...',
    'x'.repeat(200),
    '😀'.repeat(200),
  ]

  it('round-trips every key through Fastify inject', async () => {
    for (const key of KEYS) {
      const made = await upsert('ed', 'h1', key, { folderId: 'h1', values: { t1: key } })
      expect(made.statusCode, `${key}: ${made.body}`).toBe(201)
      const read = await as('vw', 'GET', byKey('h1', key))
      expect(read.statusCode, key).toBe(200)
      expect(read.json()).toMatchObject({ externalKey: key, values: { t1: key } })
    }
    expect((await itemRows()).map((r) => r.external_key)).toEqual(KEYS)
    expect((await upsert('ed', 'h1', '😀'.repeat(201), { folderId: 'h1' })).statusCode).toBe(400)
  })

  it('cannot address the keys `.` and `..`, which URLs treat as dot segments', async () => {
    // Valid keys (D64), readable by ID, but a path ending in `/.` or `/..` (encoded or not) is
    // resolved before routing. Reported on #200 for the maintainer.
    for (const key of ['.', '..']) {
      const item = await create('ed', { folderId: 'h1', externalKey: key, values: {} })
      expect(item.externalKey).toBe(key)
      for (const segment of [key, key.replaceAll('.', '%2E')]) {
        // `/by-key/` (an empty key, 400) or the hub's `items` path (404), never the item.
        const res = await as('ed', 'GET', `/hubs/h1/items/by-key/${segment}`)
        expect([400, 404], `${segment}: ${res.body}`).toContain(res.statusCode)
      }
    }
  })

  it('round-trips every key over HTTP, as the server and the image serve it', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const call = (method: string, key: string, body?: object) =>
      fetch(`${address}/v1/workspaces/${WS}${byKey('h1', key)}`, {
        method,
        headers: {
          cookie: cookies.get('ed') ?? '',
          ...(body && { 'content-type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
      })
    for (const key of KEYS) {
      const made = await call('PUT', key, { folderId: 'h1', values: { t1: key } })
      expect(made.status, key).toBe(201)
      const again = await call('PUT', key, { folderId: 'h1', values: { t1: `${key}!` } })
      expect(again.status, key).toBe(200)
      const read = await call('GET', key)
      expect(read.status, key).toBe(200)
      expect(await read.json()).toMatchObject({ externalKey: key, values: { t1: `${key}!` } })
    }
    expect((await call('PUT', '😀'.repeat(201), { folderId: 'h1' })).status).toBe(400)
  })
})
