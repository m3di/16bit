import {
  conflictErrorSchema,
  hubDescriptionSchema,
  hubPageSchema,
  itemPageSchema,
  itemSchema,
  workspacePageSchema,
  type Item,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'
import { encodeCursor } from './http.ts'

// Integration tests: the real app against a fresh, migrated Postgres database per test.

const ACTOR = 'dev-owner'

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let auth: { cookie: string }

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  auth = await sessionCookie(db, ACTOR)
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * w1: the caller is owner. Hub `build` (prefix BLD) with subfolder `bugs`; attributes
 * title (text, required), points (number), stage (select). Hub `docs` is empty.
 * w2: the caller is not a principal there, so it must be invisible.
 */
async function seed(): Promise<void> {
  await db
    .insertInto('workspace')
    .values([
      { id: 'w1', name: 'Alpha' },
      { id: 'w2', name: 'Other' },
    ])
    .execute()
  await db
    .insertInto('principal')
    .values([
      { workspace_id: 'w1', id: ACTOR, kind: 'user', name: 'Dev', workspace_role: 'owner' },
      { workspace_id: 'w2', id: 'someone', kind: 'user', name: 'X', workspace_role: 'owner' },
    ])
    .execute()
  const hub = (workspace_id: string, id: string, name: string) => ({
    workspace_id,
    id,
    hub_id: id,
    parent_id: null,
    name,
    color: 'blue',
    id_prefix: 'BLD',
  })
  await db
    .insertInto('folder')
    .values([hub('w1', 'build', 'Build'), hub('w1', 'docs', 'Docs'), hub('w2', 'secret', 'S')])
    .execute()
  await db
    .insertInto('folder')
    .values({ ...hub('w1', 'bugs', 'Bugs'), hub_id: 'build', parent_id: 'build' })
    .execute()
  await db
    .insertInto('attribute')
    .values([
      { workspace_id: 'w1', id: 'title', hub_id: 'build', name: 'Title', type: 'text', config: {} },
      {
        workspace_id: 'w1',
        id: 'points',
        hub_id: 'build',
        name: 'Points',
        type: 'number',
        config: { min: 0 },
      },
      {
        workspace_id: 'w1',
        id: 'stage',
        hub_id: 'build',
        name: 'Stage',
        type: 'select',
        config: JSON.stringify({ options: [{ id: 'todo', label: 'To do' }] }),
      },
    ])
    .execute()
  const fa = (folder_id: string, attribute_id: string, position: number, required = false) => ({
    workspace_id: 'w1',
    hub_id: 'build',
    folder_id,
    attribute_id,
    position,
    required,
  })
  await db
    .insertInto('folder_attribute')
    .values([
      fa('build', 'title', 0, true),
      fa('build', 'points', 1),
      fa('build', 'stage', 2),
      fa('bugs', 'title', 0, true),
    ])
    .execute()
  // Owners see nothing inside a hub without a grant (D45).
  await db
    .insertInto('hub_grant')
    .values([
      { workspace_id: 'w1', hub_id: 'build', principal_id: ACTOR, hub_role: 'hub_admin' },
      { workspace_id: 'w1', hub_id: 'docs', principal_id: ACTOR, hub_role: 'hub_admin' },
    ])
    .execute()
}

function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: auth,
    ...(payload ? { payload } : {}),
  })
}

async function create(values: Record<string, unknown>, folderId = 'build'): Promise<Item> {
  const res = await request('POST', '/v1/workspaces/w1/items', { folderId, values })
  expect(res.statusCode).toBe(201)
  return itemSchema.parse(res.json())
}

async function hubCount(id: string): Promise<number> {
  const row = await db
    .selectFrom('folder')
    .select('item_count')
    .where('workspace_id', '=', 'w1')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return row.item_count
}

const revisions = () =>
  db.selectFrom('revision').selectAll().where('workspace_id', '=', 'w1').orderBy('seq').execute()

describe('health', () => {
  it('answers without auth when the database is up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('answers 503 when the database is down', async () => {
    const dead = createDb('postgres://nobody:wrong@127.0.0.1:1/none')
    const deadApp = buildApp({ db: dead })
    const res = await deadApp.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    await deadApp.close()
    await dead.destroy()
  })
})

describe('auth', () => {
  it.each([undefined, 'Bearer wrong', 'Basic dGVzdA==', 'Bearer '])(
    'rejects authorization %s with 401',
    async (authorization) => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: authorization ? { authorization } : {},
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ error: 'unauthorized' })
    },
  )

  it('hides a workspace the caller is not a principal in', async () => {
    for (const url of ['/v1/workspaces/w2/hubs', '/v1/workspaces/w2/hubs/secret']) {
      const res = await request('GET', url)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ error: 'not_found' })
    }
  })
})

describe('workspaces and hubs', () => {
  it('lists only the caller’s workspaces', async () => {
    const res = await request('GET', '/v1/workspaces')
    expect(res.statusCode).toBe(200)
    const page = workspacePageSchema.parse(res.json())
    expect(page.items.map((w) => w.id)).toEqual(['w1'])
    expect(page.nextCursor).toBeNull()
  })

  it('lists hubs by name with item counts, and pages them', async () => {
    await create({ title: 'One' }, 'bugs')
    const first = hubPageSchema.parse(
      (await request('GET', '/v1/workspaces/w1/hubs?limit=1')).json(),
    )
    expect(first.items.map((h) => h.access === 'granted' && [h.id, h.itemCount])).toEqual([
      ['build', 1],
    ])
    expect(first.nextCursor).not.toBeNull()
    const second = hubPageSchema.parse(
      (
        await request('GET', `/v1/workspaces/w1/hubs?limit=1&cursor=${String(first.nextCursor)}`)
      ).json(),
    )
    expect(second.items.map((h) => h.id)).toEqual(['docs'])
    expect(second.nextCursor).toBeNull()
  })

  it('rejects a bad limit and a bad cursor', async () => {
    for (const q of ['limit=0', 'limit=201', 'cursor=nope', 'extra=1']) {
      const res = await request('GET', `/v1/workspaces/w1/hubs?${q}`)
      expect(res.statusCode, q).toBe(400)
      expect(res.json()).toMatchObject({ error: 'invalid_request' })
    }
  })

  it('describes a hub with its folders and attributes', async () => {
    const res = await request('GET', '/v1/workspaces/w1/hubs/build')
    expect(res.statusCode).toBe(200)
    const hub = hubDescriptionSchema.parse(res.json())
    expect(hub.hub.id).toBe('build')
    expect(hub.folders.map((f) => f.id)).toEqual(['bugs'])
    expect(hub.attributes.map((a) => a.id).sort()).toEqual(['points', 'stage', 'title'])
    expect(hub.folderAttributes.filter((fa) => fa.folderId === 'build')).toHaveLength(3)
    expect(hub.truncated).toEqual({ folders: false, attributes: false, folderAttributes: false })
  })

  it('says which lists were cut off at the cap', async () => {
    const describeBuild = async () => {
      const res = await request('GET', '/v1/workspaces/w1/hubs/build')
      return hubDescriptionSchema.parse(res.json())
    }
    await app.close()
    app = buildApp({ db: appDb, maxHubEntries: 1 })
    // build has 1 subfolder, 3 attributes and 4 folder attributes: only attributes exceed 1.
    const atCap = await describeBuild()
    expect(atCap.folders).toHaveLength(1)
    expect(atCap.attributes).toHaveLength(1)
    expect(atCap.folderAttributes).toHaveLength(4)
    expect(atCap.truncated).toEqual({ folders: false, attributes: true, folderAttributes: false })

    await db
      .insertInto('folder')
      .values({
        workspace_id: 'w1',
        id: 'tasks',
        hub_id: 'build',
        parent_id: 'build',
        name: 'Tasks',
        color: 'blue',
        id_prefix: 'BLD',
      })
      .execute()
    // Four more attributes on build, two on tasks: 7 + 1 (bugs) + 2 (tasks) = 10 folder
    // attributes, exactly the cap of 10 (maxHubEntries * 10). A third on tasks goes over.
    const extra = ['a1', 'a2', 'a3', 'a4']
    const text = (id: string) => ({
      workspace_id: 'w1',
      id,
      hub_id: 'build',
      name: id,
      type: 'text' as const,
      config: {},
    })
    await db.insertInto('attribute').values(extra.map(text)).execute()
    const fa = (folder_id: string, attribute_id: string, position: number) => ({
      workspace_id: 'w1',
      hub_id: 'build',
      folder_id,
      attribute_id,
      position,
      required: false,
    })
    await db
      .insertInto('folder_attribute')
      .values([
        ...extra.map((id, i) => fa('build', id, 3 + i)),
        fa('tasks', 'title', 0),
        fa('tasks', 'points', 1),
      ])
      .execute()
    const faAtCap = await describeBuild()
    expect(faAtCap.folderAttributes).toHaveLength(10)
    expect(faAtCap.truncated.folderAttributes).toBe(false)

    await db
      .insertInto('folder_attribute')
      .values(fa('tasks', 'stage', 2))
      .execute()
    const over = await describeBuild()
    expect(over.folders.map((f) => f.id)).toEqual(['bugs'])
    expect(over.folderAttributes).toHaveLength(10)
    expect(over.truncated).toEqual({ folders: true, attributes: true, folderAttributes: true })
  })

  it('returns 404 for a folder that is not a hub, or a missing hub', async () => {
    for (const id of ['bugs', 'missing']) {
      const res = await request('GET', `/v1/workspaces/w1/hubs/${id}`)
      expect(res.statusCode).toBe(404)
    }
  })
})

describe('create item', () => {
  it('validates, numbers per hub, counts, and logs a revision', async () => {
    const a = await create({ title: 'First', points: 3, stage: 'todo' })
    const b = await create({ title: 'Second' }, 'bugs')
    expect([a.seqId, b.seqId]).toEqual([1, 2])
    expect(a).toMatchObject({ workspaceId: 'w1', hubId: 'build', version: 1, updatedBy: ACTOR })
    expect(b.hubId).toBe('build')
    expect(await hubCount('build')).toBe(2)
    expect(await hubCount('bugs')).toBe(1)

    const log = await revisions()
    expect(log.map((r) => [r.seq, r.item_id, r.version])).toEqual([
      [1, a.id, 1],
      [2, b.id, 1],
    ])
    expect(log[0]?.patch).toEqual({
      op: 'create',
      folderId: 'build',
      values: { title: 'First', points: 3, stage: 'todo' },
    })
  })

  it('accepts a client ID once and never reuses it, even after a delete', async () => {
    const item = await create({ title: 'Mine' })
    const withId = await request('POST', '/v1/workspaces/w1/items', {
      id: 'issue-6',
      folderId: 'build',
      values: { title: 'Six' },
    })
    expect(withId.statusCode).toBe(201)
    const again = await request('POST', '/v1/workspaces/w1/items', {
      id: 'issue-6',
      folderId: 'build',
      values: { title: 'Six' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: 'id_taken' })

    await request('DELETE', `/v1/workspaces/w1/items/${item.id}?version=1`)
    const reuse = await request('POST', '/v1/workspaces/w1/items', {
      id: item.id,
      folderId: 'build',
      values: { title: 'Back' },
    })
    expect(reuse.statusCode).toBe(409)
    expect(await hubCount('build')).toBe(1)
  })

  it('returns 422 with every value error and writes nothing', async () => {
    const res = await request('POST', '/v1/workspaces/w1/items', {
      folderId: 'build',
      values: { points: -1, stage: 'nope', other: 1 },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json<{ error: string; errors: { attributeId: string; code: string }[] }>()
    expect(body.error).toBe('invalid_values')
    expect(body.errors.map((e) => [e.attributeId, e.code]).sort()).toEqual([
      ['other', 'unknown_attribute'],
      ['points', 'invalid_value'],
      ['stage', 'invalid_value'],
      ['title', 'required'],
    ])
    expect(await hubCount('build')).toBe(0)
    expect(await revisions()).toEqual([])
  })

  it('rejects an attribute the folder does not show', async () => {
    const res = await request('POST', '/v1/workspaces/w1/items', {
      folderId: 'bugs',
      values: { title: 'x', points: 1 },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for a missing folder and 400 for a malformed body', async () => {
    const missing = await request('POST', '/v1/workspaces/w1/items', {
      folderId: 'nope',
      values: {},
    })
    expect(missing.statusCode).toBe(404)
    const malformed = await request('POST', '/v1/workspaces/w1/items', { values: {} })
    expect(malformed.statusCode).toBe(400)
    const notJson = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/w1/items',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{',
    })
    expect(notJson.statusCode).toBe(400)
    expect(notJson.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('cannot create in another workspace’s folder', async () => {
    const before = await workspaceSnapshot(db, 'w2')
    const res = await request('POST', '/v1/workspaces/w2/items', {
      folderId: 'secret',
      values: {},
    })
    expect(res.statusCode).toBe(404)
    expect(await workspaceSnapshot(db, 'w2')).toEqual(before)
  })
})

describe('get item', () => {
  it('reads an item and 404s on a missing one', async () => {
    const item = await create({ title: 'Read me' })
    const res = await request('GET', `/v1/workspaces/w1/items/${item.id}`)
    expect(res.statusCode).toBe(200)
    expect(itemSchema.parse(res.json())).toEqual(item)
    expect((await request('GET', '/v1/workspaces/w1/items/missing')).statusCode).toBe(404)
  })
})

describe('patch item', () => {
  it('merges values, clears nulls, bumps the version, and logs the patch', async () => {
    const item = await create({ title: 'Old', points: 2 })
    const res = await request('PATCH', `/v1/workspaces/w1/items/${item.id}`, {
      version: 1,
      values: { title: 'New', points: null },
    })
    expect(res.statusCode).toBe(200)
    const patched = itemSchema.parse(res.json())
    expect(patched.values).toEqual({ title: 'New' })
    expect(patched.version).toBe(2)

    const log = await revisions()
    expect(log.at(-1)).toMatchObject({
      seq: 2,
      version: 2,
      patch: { op: 'update', values: { title: 'New', points: null } },
    })
  })

  it('clears only top-level nulls and keeps nested nulls', async () => {
    const item = await create({ title: 'Old', points: 2 })
    // No M0 type has nested values, so a nested value is written directly, as a later type
    // (rich text, for example) would store it.
    const nested = { blocks: [{ text: 'a', mark: null }], meta: { owner: null } }
    await db
      .updateTable('item')
      .set({ values: JSON.stringify({ title: 'Old', points: 2, doc: nested }) })
      .where('workspace_id', '=', 'w1')
      .where('id', '=', item.id)
      .execute()
    const res = await request('PATCH', `/v1/workspaces/w1/items/${item.id}`, {
      version: 1,
      values: { title: 'New', points: null },
    })
    expect(res.statusCode).toBe(200)
    // Read the row: the response schema only knows M0's flat value types.
    const row = await db
      .selectFrom('item')
      .select('values')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow()
    expect(row.values).toEqual({ title: 'New', doc: nested })
  })

  it('returns 409 with the current item on a stale version, and writes nothing', async () => {
    const item = await create({ title: 'Base' })
    await request('PATCH', `/v1/workspaces/w1/items/${item.id}`, {
      version: 1,
      values: { title: 'Theirs' },
    })
    const stale = await request('PATCH', `/v1/workspaces/w1/items/${item.id}`, {
      version: 1,
      values: { title: 'Mine' },
    })
    expect(stale.statusCode).toBe(409)
    const body = conflictErrorSchema.parse(stale.json())
    expect(body.current.version).toBe(2)
    expect(body.current.values).toEqual({ title: 'Theirs' })
    expect(await revisions()).toHaveLength(2)
  })

  it('lets exactly one of two concurrent patches on the same version win', async () => {
    const item = await create({ title: 'Race' })
    const results = await Promise.all(
      ['A', 'B'].map((title) =>
        request('PATCH', `/v1/workspaces/w1/items/${item.id}`, { version: 1, values: { title } }),
      ),
    )
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await revisions()).toHaveLength(2)
  })

  it('rejects invalid values with 422, and clearing a required value', async () => {
    const item = await create({ title: 'Keep' })
    for (const values of [{ points: 'many' }, { title: null }, { title: '' }]) {
      const res = await request('PATCH', `/v1/workspaces/w1/items/${item.id}`, {
        version: 1,
        values,
      })
      expect(res.statusCode, JSON.stringify(values)).toBe(422)
    }
    expect((await request('GET', `/v1/workspaces/w1/items/${item.id}`)).json()).toMatchObject({
      version: 1,
    })
  })

  it('returns 400 without a version or values, and 404 for a missing item', async () => {
    const item = await create({ title: 'x' })
    const url = `/v1/workspaces/w1/items/${item.id}`
    expect((await request('PATCH', url, { values: { title: 'y' } })).statusCode).toBe(400)
    expect((await request('PATCH', url, { version: 1, values: {} })).statusCode).toBe(400)
    const missing = await request('PATCH', '/v1/workspaces/w1/items/missing', {
      version: 1,
      values: { title: 'y' },
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('delete item', () => {
  it('deletes on the right version, decrements counts, and logs it', async () => {
    const item = await create({ title: 'Bye' }, 'bugs')
    const res = await request('DELETE', `/v1/workspaces/w1/items/${item.id}?version=1`)
    expect(res.statusCode).toBe(204)
    expect(await hubCount('build')).toBe(0)
    expect(await hubCount('bugs')).toBe(0)
    expect((await revisions()).at(-1)).toMatchObject({ version: 2, patch: { op: 'delete' } })
    expect((await request('GET', `/v1/workspaces/w1/items/${item.id}`)).statusCode).toBe(404)
  })

  it('returns 409 with the current item on a stale version, and keeps it', async () => {
    const item = await create({ title: 'Stay' })
    await request('PATCH', `/v1/workspaces/w1/items/${item.id}`, {
      version: 1,
      values: { title: 'Moved on' },
    })
    const res = await request('DELETE', `/v1/workspaces/w1/items/${item.id}?version=1`)
    expect(res.statusCode).toBe(409)
    expect(conflictErrorSchema.parse(res.json()).current.version).toBe(2)
    expect(await hubCount('build')).toBe(1)
  })

  it('returns 400 without a version and 404 for a missing item', async () => {
    const item = await create({ title: 'x' })
    expect((await request('DELETE', `/v1/workspaces/w1/items/${item.id}`)).statusCode).toBe(400)
    expect((await request('DELETE', '/v1/workspaces/w1/items/missing?version=1')).statusCode).toBe(
      404,
    )
  })
})

describe('workspace isolation', () => {
  /** A w2 item with the given ID, written directly: the caller cannot reach w2 through the API. */
  async function foreignItem(id: string): Promise<void> {
    await db
      .insertInto('item')
      .values({
        workspace_id: 'w2',
        id,
        hub_id: 'secret',
        folder_id: 'secret',
        seq_id: 1,
        values: JSON.stringify({ title: 'Theirs' }),
        updated_by: 'someone',
      })
      .execute()
  }

  const foreignRow = (id: string) =>
    db
      .selectFrom('item')
      .select(['values', 'version'])
      .where('workspace_id', '=', 'w2')
      .where('id', '=', id)
      .executeTakeFirst()

  it('returns 404 on get, patch and delete of another workspace’s item', async () => {
    await foreignItem('foreign')
    const before = await foreignRow('foreign')
    const w2Before = await workspaceSnapshot(db, 'w2')
    for (const ws of ['w1', 'w2']) {
      const url = `/v1/workspaces/${ws}/items/foreign`
      expect((await request('GET', url)).statusCode, `GET ${ws}`).toBe(404)
      const patch = await request('PATCH', url, { version: 1, values: { title: 'Mine' } })
      expect(patch.statusCode, `PATCH ${ws}`).toBe(404)
      expect((await request('DELETE', `${url}?version=1`)).statusCode, `DELETE ${ws}`).toBe(404)
    }
    expect(await foreignRow('foreign')).toEqual(before)
    expect(await revisions()).toHaveLength(0)
    expect(await workspaceSnapshot(db, 'w2')).toEqual(w2Before)
  })

  it('touches only its own workspace’s item when IDs collide', async () => {
    const item = await create({ title: 'Ours' })
    await foreignItem(item.id)
    const before = await foreignRow(item.id)
    const w2Before = await workspaceSnapshot(db, 'w2')
    const url = `/v1/workspaces/w1/items/${item.id}`
    expect((await request('GET', url)).json()).toMatchObject({ values: { title: 'Ours' } })
    const patched = await request('PATCH', url, { version: 1, values: { title: 'Two' } })
    expect(patched.statusCode).toBe(200)
    expect((await request('DELETE', `${url}?version=2`)).statusCode).toBe(204)
    expect(await foreignRow(item.id)).toEqual(before)
    expect(await workspaceSnapshot(db, 'w2')).toEqual(w2Before)
  })
})

describe('error status codes', () => {
  it('keeps 413 for a body over the limit', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/w1/items',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ folderId: 'build', values: { title: huge } }),
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('keeps 415 for an unsupported content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/w1/items',
      headers: { ...auth, 'content-type': 'application/xml' },
      payload: '<item/>',
    })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
  })
})

describe('query items', () => {
  it('pages a folder newest update first without skipping or repeating', async () => {
    const created: Item[] = []
    for (let i = 0; i < 5; i++) created.push(await create({ title: `T${String(i)}` }))
    // Same updated_at for two rows: the id breaks the tie.
    await db
      .updateTable('item')
      .set({ updated_at: '2026-01-01T00:00:00.123456Z' })
      .where('id', 'in', [created[1]?.id ?? '', created[2]?.id ?? ''])
      .execute()
    await create({ title: 'Elsewhere' }, 'bugs')

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const res = await request('POST', '/v1/workspaces/w1/query', {
        from: 'build',
        limit: 2,
        cursor,
      })
      expect(res.statusCode).toBe(200)
      const page = itemPageSchema.parse(res.json())
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(5)
    expect(new Set(seen)).toEqual(new Set(created.map((i) => i.id)))
    expect(seen.slice(-2)).toEqual([created[1]?.id, created[2]?.id].sort().reverse())
  })

  it('returns 404 for a missing folder and 400 for bad input', async () => {
    const res404 = await request('POST', '/v1/workspaces/w1/query', { from: 'nope', limit: 5 })
    expect(res404.statusCode).toBe(404)
    for (const body of [
      { from: 'build' },
      { from: 'build', limit: 0 },
      { from: 'build', limit: 500 },
      { from: 'build', limit: 5, cursor: encodeCursor(['not-a-date', 'x']) },
      { from: 'build', limit: 5, where: {} },
    ]) {
      const res = await request('POST', '/v1/workspaces/w1/query', body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
  })
})
