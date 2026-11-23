import {
  batchResponseSchema,
  jsonDepthPath,
  MAX_VIEW_JSON_DEPTH,
  createdAgentKeySchema,
  defaultViewTree,
  invalidViewErrorSchema,
  viewConflictErrorSchema,
  viewSchema,
  type View,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { LightMyRequestResponse } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { createItem } from './items.ts'
import { validateViewTree } from './views.ts'

// The root view API (M4-03, D76 to D79) against a real Postgres, through the API's role under
// row-level security. Contracts: packages/core/src/views.ts. Migration: 0016.

const WS = 'w1'
let db: Kysely<Database>
let appDb: Kysely<Database>
let ownerUrl: string
let drop: () => Promise<void>
let app: FastifyInstance
const cookies = new Map<string, string>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  ownerUrl = test.url
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  app = buildApp({ db: appDb })
  for (const who of ['own', 'adm', 'ha', 'ed', 'cm', 'vw', 'out']) {
    cookies.set(who, (await sessionCookie(db, who)).cookie)
  }
})

afterEach(async () => {
  await app.close()
  cookies.clear()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * w1. Hubs:
 *   h1  folders f1 (items, attributes title, stage, notes, done), f2 (title only),
 *       home (views-only); attributes title (text), stage (select todo/doing/done, indexed),
 *       notes (text, not indexed), done (date, indexed)
 *   h2  folder g1; attribute t2
 * Principals: own owner (hub_admin h1), adm admin (no grant on h1), ha member hub_admin h1 and
 * h2, ed editor h1, cm commenter h1, vw viewer h1, out no grants.
 */
async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: WS, name: 'Alpha' }).execute()
  const p = (id: string, role: 'owner' | 'admin' | 'member' | 'viewer') => ({
    workspace_id: WS,
    id,
    kind: 'user' as const,
    name: id,
    workspace_role: role,
  })
  await db
    .insertInto('principal')
    .values([
      p('own', 'owner'),
      p('adm', 'admin'),
      p('ha', 'member'),
      p('ed', 'member'),
      p('cm', 'member'),
      p('vw', 'viewer'),
      p('out', 'member'),
    ])
    .execute()
  const folder = (id: string, hub: string, extra: object = {}) => ({
    workspace_id: WS,
    id,
    hub_id: hub,
    parent_id: id === hub ? null : hub,
    name: id,
    color: 'blue',
    id_prefix: hub.toUpperCase(),
    ...extra,
  })
  await db
    .insertInto('folder')
    .values([folder('h1', 'h1'), folder('h2', 'h2')])
    .execute()
  await db
    .insertInto('folder')
    .values([
      folder('f1', 'h1'),
      folder('f2', 'h1'),
      folder('home', 'h1', { views_only: true }),
      folder('g1', 'h2'),
    ])
    .execute()
  const a = (
    id: string,
    hub: string,
    type: string,
    config: Record<string, unknown> = {},
    indexed = false,
  ) => ({
    workspace_id: WS,
    id,
    hub_id: hub,
    name: id,
    type: type as 'text',
    config,
    indexed,
  })
  const options = { options: ['todo', 'doing', 'done'].map((id) => ({ id, label: id })) }
  await db
    .insertInto('attribute')
    .values([
      a('title', 'h1', 'text'),
      a('stage', 'h1', 'select', options, true),
      a('notes', 'h1', 'text'),
      a('done', 'h1', 'date', {}, true),
      a('t2', 'h2', 'text'),
    ])
    .execute()
  const fa = (hub: string, folderId: string, attributeId: string, position: number) => ({
    workspace_id: WS,
    hub_id: hub,
    folder_id: folderId,
    attribute_id: attributeId,
    position,
  })
  await db
    .insertInto('folder_attribute')
    .values([
      fa('h1', 'f1', 'title', 0),
      fa('h1', 'f1', 'stage', 1),
      fa('h1', 'f1', 'notes', 2),
      fa('h1', 'f1', 'done', 3),
      fa('h1', 'f2', 'title', 0),
      fa('h2', 'g1', 't2', 0),
    ])
    .execute()
  const g = (hub: string, principal: string, role: string) => ({
    workspace_id: WS,
    hub_id: hub,
    principal_id: principal,
    hub_role: role as 'viewer',
  })
  await db
    .insertInto('hub_grant')
    .values([
      g('h1', 'own', 'hub_admin'),
      g('h1', 'ha', 'hub_admin'),
      g('h2', 'ha', 'hub_admin'),
      g('h1', 'ed', 'editor'),
      g('h1', 'cm', 'commenter'),
      g('h1', 'vw', 'viewer'),
    ])
    .execute()
  await createItem(db, WS, 'own', { id: 'i1', folderId: 'f1', values: { title: 'One' } })
}

type Caller = (method: string, url: string, payload?: object) => Promise<LightMyRequestResponse>

const person =
  (who: string): Caller =>
  (method, url, payload) =>
    app.inject({
      method: method as 'GET',
      url: `/v1/workspaces/${WS}${url}`,
      headers: { cookie: cookies.get(who) ?? '' },
      ...(payload !== undefined && { payload }),
    })

/** A new agent key on h1 with `hubRole` (agents are never hub admins, D28). */
async function agent(hubRole: 'editor' | 'viewer' = 'editor'): Promise<Caller> {
  const res = await person('own')('POST', '/hubs/h1/agent-keys', { name: 'bot', hubRole })
  expect(res.statusCode, res.body).toBe(201)
  const { secret } = createdAgentKeySchema.parse(res.json())
  return (method, url, payload) =>
    app.inject({
      method: method as 'GET',
      url: `/v1/workspaces/${WS}${url}`,
      headers: { authorization: `Bearer ${secret}` },
      ...(payload !== undefined && { payload }),
    })
}

const ha = person('ha')

/** A page with one table block bound to `folderId`, plus `binding` and `blocks`. */
const tableTree = (folderId: string, binding: object = {}, blocks: object[] = []) => ({
  schemaVersion: 1,
  root: {
    id: 'page',
    type: 'page',
    config: { title: 'Home' },
    children: [
      { id: 't', type: 'table', config: { binding: { folderId, ...binding } } },
      ...blocks,
    ],
  },
})

const put = (who: Caller, folderId: string, version: number, tree: unknown) =>
  who('PUT', `/folders/${folderId}/view`, { version, tree })

const viewRow = (folderId: string) =>
  db
    .selectFrom('view')
    .selectAll()
    .where('workspace_id', '=', WS)
    .where('folder_id', '=', folderId)
    .executeTakeFirst()

/** Stores a first view on f1 as ha, and returns it. */
async function stored(folderId = 'f1'): Promise<View> {
  const res = await put(ha, folderId, 0, tableTree('f1'))
  expect(res.statusCode, res.body).toBe(200)
  return viewSchema.parse(res.json())
}

describe('GET /folders/:folderId/view', () => {
  it('answers the default view with version 0 when none is stored (D76)', async () => {
    const res = await ha('GET', '/folders/f1/view')
    expect(res.statusCode, res.body).toBe(200)
    const view = viewSchema.parse(res.json())
    expect(view).toMatchObject({
      folderId: 'f1',
      hubId: 'h1',
      stored: false,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    })
    expect(view.tree).toEqual(defaultViewTree('f1', { viewsOnly: false }))
    expect(view.seq).toBeGreaterThan(0)

    // The hub root too; a views-only folder's default is an empty page ("No view yet").
    const root = viewSchema.parse((await ha('GET', '/folders/h1/view')).json())
    expect(root.tree).toEqual(defaultViewTree('h1', { viewsOnly: false }))
    const home = viewSchema.parse((await ha('GET', '/folders/home/view')).json())
    expect(home.tree).toEqual(defaultViewTree('home', { viewsOnly: true }))
    expect(home.tree.root.children).toEqual([])
  })

  it('answers the stored view to every reader of the hub, agents included', async () => {
    const view = await stored()
    const bot = await agent('viewer')
    for (const who of [person('own'), ha, person('ed'), person('cm'), person('vw'), bot]) {
      const res = await who('GET', '/folders/f1/view')
      expect(res.statusCode, res.body).toBe(200)
      expect(viewSchema.parse(res.json())).toMatchObject({
        stored: true,
        version: 1,
        updatedBy: 'ha',
        tree: view.tree,
      })
    }
  })

  it('serves the default tree for a stored view that no longer parses, at its version', async () => {
    await stored()
    // As a broken upgrade would leave it: a block type core no longer knows.
    await db
      .updateTable('view')
      .set({
        tree: JSON.stringify({
          schemaVersion: 1,
          root: { id: 'page', type: 'page', config: {}, children: [{ id: 'g', type: 'gone' }] },
        }),
      })
      .where('folder_id', '=', 'f1')
      .execute()
    const res = await person('vw')('GET', '/folders/f1/view')
    expect(res.statusCode, res.body).toBe(200)
    const view = viewSchema.parse(res.json())
    expect(view).toMatchObject({ stored: true, version: 1, updatedBy: 'ha' })
    expect(view.tree).toEqual(defaultViewTree('f1', { viewsOnly: false }))
    // A hub admin replaces it at that version.
    expect((await put(ha, 'f1', 1, tableTree('f2'))).statusCode).toBe(200)
  })

  it('hides a folder without a grant on its hub, even from owners and admins (D45)', async () => {
    for (const who of ['out', 'adm']) {
      const res = await person(who)('GET', '/folders/f1/view')
      expect(res.statusCode, who).toBe(404)
      expect(res.json()).toMatchObject({ error: 'not_found', message: 'Folder not found' })
    }
    expect((await person('ed')('GET', '/folders/g1/view')).statusCode).toBe(404)
    expect((await ha('GET', '/folders/missing/view')).statusCode).toBe(404)
  })
})

describe('PUT /folders/:folderId/view', () => {
  it('stores a first view at version 0 and replaces it at its version', async () => {
    const res = await put(ha, 'f1', 0, tableTree('f1', { sort: [{ attribute: 'stage' }] }))
    expect(res.statusCode, res.body).toBe(200)
    const first = viewSchema.parse(res.json())
    expect(first).toMatchObject({ folderId: 'f1', hubId: 'h1', stored: true, version: 1 })
    expect(first.updatedBy).toBe('ha')
    expect(first.updatedAt).not.toBeNull()
    // Defaults filled in, as stored.
    expect(first.tree.root.children?.[0]).toMatchObject({
      config: { binding: { limit: 50, sort: [{ attribute: 'stage', direction: 'asc' }] } },
    })
    const row = await viewRow('f1')
    expect(row).toMatchObject({ hub_id: 'h1', version: 1, updated_by: 'ha' })
    expect(row?.tree).toEqual(first.tree)

    const owner = person('own')
    const next = await put(owner, 'f1', 1, tableTree('f2'))
    expect(next.statusCode, next.body).toBe(200)
    expect(viewSchema.parse(next.json())).toMatchObject({ version: 2, updatedBy: 'own' })
    expect(await viewRow('f1')).toMatchObject({ version: 2, updated_by: 'own' })
  })

  it('stores views on the hub root and on views-only folders', async () => {
    expect((await put(ha, 'h1', 0, tableTree('f1'))).statusCode).toBe(200)
    const res = await put(ha, 'home', 0, tableTree('f2'))
    expect(res.statusCode, res.body).toBe(200)
    expect(viewSchema.parse(res.json())).toMatchObject({ folderId: 'home', version: 1 })
  })

  it('refuses every role below hub admin, agents included (D78)', async () => {
    const tree = tableTree('f1')
    const bot = await agent('editor')
    for (const [name, who] of [
      ['ed', person('ed')],
      ['cm', person('cm')],
      ['vw', person('vw')],
      ['agent', bot],
    ] as const) {
      const res = await put(who, 'f1', 0, tree)
      expect(res.statusCode, name).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden' })
    }
    for (const who of ['out', 'adm']) {
      expect((await put(person(who), 'f1', 0, tree)).statusCode, who).toBe(404)
    }
    expect((await put(ha, 'missing', 0, tree)).statusCode).toBe(404)
    expect(await viewRow('f1')).toBeUndefined()
  })

  it('answers 409 conflict with the current view on a stale version', async () => {
    await stored()
    for (const version of [0, 2, 7]) {
      const res = await put(ha, 'f1', version, tableTree('f2'))
      expect(res.statusCode, String(version)).toBe(409)
      const body = viewConflictErrorSchema.parse(res.json())
      expect(body.current).toMatchObject({ stored: true, version: 1, updatedBy: 'ha' })
    }
    // A version for a view that was never stored: `current` is the default.
    const res = await put(ha, 'f2', 3, tableTree('f2'))
    expect(res.statusCode).toBe(409)
    expect(viewConflictErrorSchema.parse(res.json()).current).toMatchObject({
      folderId: 'f2',
      stored: false,
      version: 0,
    })
    expect(await viewRow('f1')).toMatchObject({ version: 1 })
  })

  it('answers 422 invalid_view at the path of each structural error', async () => {
    const res = await put(ha, 'f1', 0, {
      schemaVersion: 1,
      root: { id: 'page', type: 'page', config: {}, children: [{ id: 'h', type: 'heading' }] },
    })
    expect(res.statusCode, res.body).toBe(422)
    const body = invalidViewErrorSchema.parse(res.json())
    expect(body.errors.map((e) => e.path)).toContain('root.children.0.config')

    const nested = await put(ha, 'f1', 0, {
      schemaVersion: 1,
      root: {
        id: 'page',
        type: 'page',
        config: {},
        children: [{ id: 'p2', type: 'page', config: {} }],
      },
    })
    expect(nested.statusCode).toBe(422)
    expect(invalidViewErrorSchema.parse(nested.json()).errors).toContainEqual({
      path: 'root.children.0.type',
      message: 'A page is only ever the root block',
    })
    expect((await put(ha, 'f1', 0, null)).statusCode).toBe(422)
    expect(await viewRow('f1')).toBeUndefined()
  })

  it("answers 422 invalid_view for a tree that doesn't fit the hub's schema (D79)", async () => {
    const cases: [string, object, string][] = [
      // Not indexed, so it can't be filtered.
      [
        'f1',
        { where: { attribute: 'notes', op: 'eq', value: 'x' } },
        'root.children.0.config.binding.where',
      ],
      // Not on that folder.
      ['f2', { sort: [{ attribute: 'stage' }] }, 'root.children.0.config.binding.sort.0'],
      // Another hub's folder, a views-only folder, a missing one.
      ['g1', {}, 'root.children.0.config.binding.folderId'],
      ['home', {}, 'root.children.0.config.binding.folderId'],
      ['nope', {}, 'root.children.0.config.binding.folderId'],
    ]
    for (const [folderId, binding, path] of cases) {
      const res = await put(ha, 'f1', 0, tableTree(folderId, binding))
      expect(res.statusCode, `${folderId} ${JSON.stringify(binding)}`).toBe(422)
      const { errors } = invalidViewErrorSchema.parse(res.json())
      expect(errors.map((e) => e.path)).toContain(path)
    }
    expect(await viewRow('f1')).toBeUndefined()
  })

  it('answers 422, never 500, to an oversized, NUL-holding or deeply nested tree', async () => {
    const big = tableTree('f1', {}, [
      { id: 'x', type: 'text', config: { text: 'a'.repeat(5000) } },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `x${String(i)}`,
        type: 'text',
        config: { text: 'é'.repeat(2500) },
      })),
    ])
    const tooBig = await put(ha, 'f1', 0, big)
    expect(tooBig.statusCode, tooBig.body).toBe(422)
    expect(invalidViewErrorSchema.parse(tooBig.json()).errors[0]?.message).toMatch(/128 KiB/)

    const nul = await put(
      ha,
      'f1',
      0,
      tableTree('f1', {}, [{ id: 'x', type: 'heading', config: { text: 'a\u0000b' } }]),
    )
    expect(nul.statusCode, nul.body).toBe(422)

    // Arrays nested 20,000 deep: within the body limit, and far past any stack a recursive
    // scan could take.
    const deep = `{"version":0,"tree":${'['.repeat(20_000)}${']'.repeat(20_000)}}`
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${WS}/folders/f1/view`,
      headers: { cookie: cookies.get('ha') ?? '', 'content-type': 'application/json' },
      payload: deep,
    })
    expect(res.statusCode, res.body).toBe(422)
    expect(invalidViewErrorSchema.parse(res.json()).errors[0]?.message).toMatch(/nests at most/)

    const filter = { attribute: 'stage', op: 'eq', value: 'todo' }
    let where: object = filter
    for (let i = 0; i < 5_000; i++) where = { and: [where] }
    const deepFilter = await put(ha, 'f1', 0, tableTree('f1', { where }))
    expect(deepFilter.statusCode, deepFilter.body).toBe(422)
    expect(await viewRow('f1')).toBeUndefined()
  })

  it('answers 400 to a body without a version or a tree', async () => {
    const res = await ha('PUT', '/folders/f1/view', { tree: tableTree('f1') })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
    expect((await ha('PUT', '/folders/f1/view', { version: 0 })).statusCode).toBe(400)
  })
})

describe('DELETE /folders/:folderId/view', () => {
  it('resets to the default at the current version', async () => {
    await stored()
    const res = await ha('DELETE', '/folders/f1/view?version=1')
    expect(res.statusCode, res.body).toBe(204)
    expect(await viewRow('f1')).toBeUndefined()
    const view = viewSchema.parse((await ha('GET', '/folders/f1/view')).json())
    expect(view).toMatchObject({ stored: false, version: 0 })
    // Stored again from version 0.
    expect((await put(ha, 'f1', 0, tableTree('f1'))).statusCode).toBe(200)
  })

  it('answers 409 on a stale version, 404 with none stored, 400 without a version', async () => {
    await stored()
    const stale = await ha('DELETE', '/folders/f1/view?version=2')
    expect(stale.statusCode).toBe(409)
    expect(viewConflictErrorSchema.parse(stale.json()).current).toMatchObject({ version: 1 })
    expect((await ha('DELETE', '/folders/f2/view?version=1')).statusCode).toBe(404)
    expect((await ha('DELETE', '/folders/f1/view')).statusCode).toBe(400)
    expect((await ha('DELETE', '/folders/f1/view?version=0')).statusCode).toBe(400)
    expect(await viewRow('f1')).toMatchObject({ version: 1 })
  })

  it('refuses every role below hub admin, and hides the folder without a grant', async () => {
    await stored()
    const bot = await agent('editor')
    for (const who of [person('ed'), person('cm'), person('vw'), bot]) {
      expect((await who('DELETE', '/folders/f1/view?version=1')).statusCode).toBe(403)
    }
    for (const who of ['out', 'adm']) {
      expect((await person(who)('DELETE', '/folders/f1/view?version=1')).statusCode).toBe(404)
    }
    expect(await viewRow('f1')).toMatchObject({ version: 1 })
  })
})

describe('folders with views (D76)', () => {
  it('refuses to delete a folder with a stored view until the view is reset', async () => {
    const folder = await db
      .selectFrom('folder')
      .select('version')
      .where('id', '=', 'f2')
      .executeTakeFirstOrThrow()
    await stored('f2')
    const refused = await ha('DELETE', `/folders/f2?version=${String(folder.version)}`)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json()).toMatchObject({ error: 'has_view' })
    expect(await viewRow('f2')).toBeDefined()

    expect((await ha('DELETE', '/folders/f2/view?version=1')).statusCode).toBe(204)
    const res = await ha('DELETE', `/folders/f2?version=${String(folder.version)}`)
    expect(res.statusCode, res.body).toBe(204)
  })

  it('refuses items in a views-only folder with 422 views_only, by key too', async () => {
    const ed = person('ed')
    const res = await ed('POST', '/items', { folderId: 'home', values: {} })
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json()).toMatchObject({ error: 'views_only' })
    const byKey = await ed('PUT', '/hubs/h1/items/by-key/k1', { folderId: 'home', values: {} })
    expect(byKey.statusCode, byKey.body).toBe(422)
    expect(byKey.json()).toMatchObject({ error: 'views_only' })
    // A failing condition doesn't hide the real reason (422, not 412).
    const conditioned = await ed('PUT', '/hubs/h1/items/by-key/k3', {
      folderId: 'home',
      values: {},
      condition: { attribute: 'title', op: 'eq', value: 'never' },
    })
    expect(conditioned.statusCode, conditioned.body).toBe(422)
    expect(conditioned.json()).toMatchObject({ error: 'views_only' })
    const bot = await agent('editor')
    expect((await bot('POST', '/items', { folderId: 'home', values: {} })).statusCode).toBe(422)
    const count = await db
      .selectFrom('item')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('folder_id', '=', 'home')
      .executeTakeFirstOrThrow()
    expect(count.n).toBe(0)
  })

  it('refuses batch creates and upserts into a views-only folder, per operation (D65)', async () => {
    const res = await person('ed')('POST', '/items/batch', {
      operations: [
        { op: 'create', folderId: 'home', values: {} },
        { op: 'upsert', hubId: 'h1', key: 'k2', folderId: 'home', values: {} },
        { op: 'create', id: 'ok1', folderId: 'f1', values: { title: 'Fine' } },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    const { results } = batchResponseSchema.parse(res.json())
    expect(results.map((r) => r.status)).toEqual([422, 422, 201])
    for (const r of results.slice(0, 2)) {
      expect(r).toMatchObject({ error: { error: 'views_only' } })
    }
    const inHome = await db
      .selectFrom('item')
      .select('id')
      .where('folder_id', '=', 'home')
      .execute()
    expect(inHome).toEqual([])
  })

  it('removes the views of a deleted hub', async () => {
    const own = person('own')
    const hub = await own('POST', '/hubs', {
      id: 'h3',
      name: 'Three',
      color: 'blue',
      idPrefix: 'TH',
    })
    expect(hub.statusCode, hub.body).toBe(201)
    const empty = { schemaVersion: 1, root: { id: 'p', type: 'page', config: {} } }
    const res = await put(own, 'h3', 0, empty)
    expect(res.statusCode, res.body).toBe(200)
    expect((await viewRow('h3'))?.hub_id).toBe('h3')
    const deleted = await own('DELETE', '/hubs/h3?version=0')
    expect(deleted.statusCode, deleted.body).toBe(204)
    expect(await viewRow('h3')).toBeUndefined()
  })
})

describe('races', () => {
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

  /** h1's schema lock, exclusive: every view PUT waits for it after its grant check. */
  const holdSchema = () =>
    holding((trx) =>
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`16bit.hub-schema:${WS}:h1`}, 0))`.execute(
        trx,
      ),
    )

  const statuses = (answers: LightMyRequestResponse[]) => answers.map((r) => r.statusCode).sort()

  it('two first PUTs: one stores, the other answers 409 conflict, never 500', async () => {
    const release = await holdSchema()
    const racing = [put(ha, 'f1', 0, tableTree('f1')), put(person('own'), 'f1', 0, tableTree('f2'))]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(statuses(answers)).toEqual([200, 409])
    const loser = answers.find((r) => r.statusCode === 409)
    expect(viewConflictErrorSchema.parse(loser?.json()).current).toMatchObject({
      stored: true,
      version: 1,
    })
    expect(await viewRow('f1')).toMatchObject({ version: 1 })
  })

  it('two PUTs at one version: one moves it, the other answers 409', async () => {
    await stored()
    const release = await holdSchema()
    const racing = [put(ha, 'f1', 1, tableTree('f1')), put(person('own'), 'f1', 1, tableTree('f2'))]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(statuses(answers)).toEqual([200, 409])
    const loser = answers.find((r) => r.statusCode === 409)
    expect(viewConflictErrorSchema.parse(loser?.json()).current).toMatchObject({ version: 2 })
    expect(await viewRow('f1')).toMatchObject({ version: 2 })
  })

  it('a PUT and a DELETE at one version: exactly one wins', async () => {
    await stored()
    // The view row: both wait for it.
    const release = await holding((trx) =>
      trx.selectFrom('view').select('id').where('folder_id', '=', 'f1').forUpdate().execute(),
    )
    const racing = [put(ha, 'f1', 1, tableTree('f2')), ha('DELETE', '/folders/f1/view?version=1')]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    const codes = answers.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 409)).toHaveLength(1)
    expect(codes.filter((c) => c === 200 || c === 204)).toHaveLength(1)
    const row = await viewRow('f1')
    if (codes[0] === 200) expect(row).toMatchObject({ version: 2 })
    else expect(row).toBeUndefined()
  })

  it('two DELETEs at one version: one resets, the other finds nothing stored', async () => {
    await stored()
    const release = await holding((trx) =>
      trx.selectFrom('view').select('id').where('folder_id', '=', 'f1').forUpdate().execute(),
    )
    const racing = [
      ha('DELETE', '/folders/f1/view?version=1'),
      person('own')('DELETE', '/folders/f1/view?version=1'),
    ]
    await waiting(2)
    await release()
    expect(statuses(await Promise.all(racing))).toEqual([204, 404])
  })

  it('a first PUT that has inserted but not committed makes the folder delete 409 has_view', async () => {
    const folder = await db
      .selectFrom('folder')
      .select('version')
      .where('id', '=', 'f2')
      .executeTakeFirstOrThrow()
    // The owner's insert stands in for a PUT between its insert and its commit.
    const release = await holding((trx) =>
      trx
        .insertInto('view')
        .values({
          workspace_id: WS,
          id: 'v-f2',
          hub_id: 'h1',
          folder_id: 'f2',
          tree: JSON.stringify(defaultViewTree('f2', { viewsOnly: false })),
          updated_by: 'ha',
        })
        .execute(),
    )
    const deleting = ha('DELETE', `/folders/f2?version=${String(folder.version)}`)
    await waiting(1)
    await release()
    const res = await deleting
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ error: 'has_view' })
  })

  it('a PUT racing a folder delete in the other order: the folder goes, the PUT is 404', async () => {
    const folder = await db
      .selectFrom('folder')
      .select('version')
      .where('id', '=', 'f2')
      .executeTakeFirstOrThrow()
    const release = await holdSchema()
    const putting = put(ha, 'f2', 0, tableTree('f1'))
    await waiting(1)
    const deleted = await ha('DELETE', `/folders/f2?version=${String(folder.version)}`)
    expect(deleted.statusCode, deleted.body).toBe(204)
    await release()
    const res = await putting
    expect(res.statusCode, res.body).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })
})

describe('notifications (D76)', () => {
  let listener: pg.Client
  let heard: { channel: string; payload: unknown }[]

  beforeEach(async () => {
    heard = []
    listener = new pg.Client({ connectionString: ownerUrl })
    await listener.connect()
    listener.on('notification', (n) => {
      heard.push({ channel: n.channel, payload: JSON.parse(n.payload ?? 'null') })
    })
    await listener.query('LISTEN hub')
  })

  afterEach(async () => {
    await listener.end()
  })

  async function next(count = 1) {
    for (let i = 0; heard.length < count && i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return heard.splice(0)
  }

  it('sends the hub notice on PUT and DELETE, and nothing when refused', async () => {
    const notice = { channel: 'hub', payload: { workspaceId: WS, hubId: 'h1' } }
    await stored()
    expect(await next()).toEqual([notice])
    expect((await put(ha, 'f1', 0, tableTree('f1'))).statusCode).toBe(409)
    expect((await put(person('ed'), 'f1', 1, tableTree('f1'))).statusCode).toBe(403)
    expect((await put(ha, 'f1', 1, tableTree('notes'))).statusCode).toBe(422)
    expect(await next(0)).toEqual([])
    expect((await ha('DELETE', '/folders/f1/view?version=1')).statusCode).toBe(204)
    expect(await next()).toEqual([notice])
  })
})

describe('validateViewTree, for seeds', () => {
  it('checks a tree as PUT does and returns the form to store', async () => {
    const ok = await validateViewTree(db, WS, 'h1', tableTree('f1'))
    expect(ok.ok).toBe(true)
    if (ok.ok)
      expect(ok.tree.root.children?.[0]).toMatchObject({ config: { binding: { limit: 50 } } })
    const bad = await validateViewTree(db, WS, 'h1', tableTree('g1'))
    expect(bad).toMatchObject({ ok: false })
  })

  it('bounds nesting without recursion', () => {
    let deep: unknown = 1
    for (let i = 0; i < 100_000; i++) deep = [deep]
    expect(jsonDepthPath(deep)).toBe(
      Array.from({ length: MAX_VIEW_JSON_DEPTH }, () => '0').join('.'),
    )
    expect(jsonDepthPath(tableTree('f1'))).toBeNull()
  })
})
