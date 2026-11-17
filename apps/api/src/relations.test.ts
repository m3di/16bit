import {
  backlinkPageSchema,
  itemQueryResultSchema,
  itemReadSchema,
  itemSchema,
  type HubRole,
  type Item,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allReadableHubs, loadSubject, readableHubs } from './access.ts'
import { buildApp, type AppOptions } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'

// Relations, the link table, auto IDs, expand and backlinks (#47, D7, D11) on a real Postgres.
//
// Workspace w1, three hubs:
//   h1  "Work":    title, rel (-> h1), cross (-> h2, crossHub), secret (-> h3, crossHub),
//                  one (-> h1, single), num (auto ID, indexed)
//   h2  "Other":   title
//   h3  "Hidden":  title, back (-> h1, crossHub)
// Principals: `owner` (workspace owner) holds hub_admin on h1 and h2 and nothing on h3, so h3 is
// hidden from them (D45). `insider` (member) holds editor on h1, h2 and h3.

const WS = 'w1'

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let drop: () => Promise<void>
let owner: FastifyInstance
let insider: FastifyInstance
/** The session each app sends: `owner` and the capped apps as owner, `insider` as insider. */
const sessions = new WeakMap<FastifyInstance, { cookie: string }>()
let ownerSession: { cookie: string }

/** An app that signs its requests in as the owner. */
function asOwner(options: Partial<AppOptions> = {}): FastifyInstance {
  const app = buildApp({ db: appDb, ...options })
  sessions.set(app, ownerSession)
  return app
}

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  ownerSession = await sessionCookie(db, 'owner')
  owner = asOwner()
  insider = buildApp({ db: appDb })
  sessions.set(insider, await sessionCookie(db, 'insider'))
})

afterEach(async () => {
  await owner.close()
  await insider.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: WS, name: 'W' }).execute()
  await db
    .insertInto('principal')
    .values([
      { workspace_id: WS, id: 'owner', kind: 'user', name: 'Owner', workspace_role: 'owner' },
      { workspace_id: WS, id: 'insider', kind: 'user', name: 'In', workspace_role: 'member' },
    ])
    .execute()
  for (const [id, prefix] of [
    ['h1', 'WRK'],
    ['h2', 'OTH'],
    ['h3', 'HID'],
  ] as const) {
    await db
      .insertInto('folder')
      .values({
        workspace_id: WS,
        id,
        hub_id: id,
        parent_id: null,
        name: id,
        color: 'blue',
        id_prefix: prefix,
      })
      .execute()
  }
  const attribute = (hub: string, id: string, type: string, config: object, indexed = false) => ({
    workspace_id: WS,
    id,
    hub_id: hub,
    name: id,
    type: type as 'text',
    config: JSON.stringify(config),
    indexed,
  })
  const shown = {
    h1: [
      attribute('h1', 'title', 'text', {}),
      attribute('h1', 'rel', 'relation', { targetHubId: 'h1' }, true),
      attribute('h1', 'cross', 'relation', { targetHubId: 'h2', crossHub: true }),
      attribute('h1', 'secret', 'relation', { targetHubId: 'h3', crossHub: true }),
      attribute('h1', 'one', 'relation', { targetHubId: 'h1', multiple: false }),
      attribute('h1', 'num', 'auto_id', { prefix: 'WRK' }, true),
    ],
    h2: [attribute('h2', 'title2', 'text', {})],
    h3: [
      attribute('h3', 'title3', 'text', {}),
      attribute('h3', 'back', 'relation', { targetHubId: 'h1', crossHub: true }),
    ],
  }
  for (const [hub, attributes] of Object.entries(shown)) {
    await db.insertInto('attribute').values(attributes).execute()
    await db
      .insertInto('folder_attribute')
      .values(
        attributes.map((a, position) => ({
          workspace_id: WS,
          hub_id: hub,
          folder_id: hub,
          attribute_id: a.id,
          position,
        })),
      )
      .execute()
  }
  const grant = (hub: string, principal: string, role: HubRole) => ({
    workspace_id: WS,
    hub_id: hub,
    principal_id: principal,
    hub_role: role,
  })
  await db
    .insertInto('hub_grant')
    .values([
      grant('h1', 'owner', 'hub_admin'),
      grant('h2', 'owner', 'hub_admin'),
      grant('h1', 'insider', 'editor'),
      grant('h2', 'insider', 'editor'),
      grant('h3', 'insider', 'editor'),
    ])
    .execute()
}

const auth = (app: FastifyInstance) => sessions.get(app)

async function create(
  app: FastifyInstance,
  id: string,
  folderId: string,
  values: object = {},
): Promise<Item> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/items`,
    headers: auth(app),
    payload: { id, folderId, values },
  })
  expect(res.statusCode, res.body).toBe(201)
  return itemSchema.parse(res.json())
}

function createRaw(app: FastifyInstance, id: string, folderId: string, values: object) {
  return app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/items`,
    headers: auth(app),
    payload: { id, folderId, values },
  })
}

function patch(app: FastifyInstance, id: string, version: number, values: object) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${WS}/items/${id}`,
    headers: auth(app),
    payload: { version, values },
  })
}

function remove(app: FastifyInstance, id: string, version: number) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/workspaces/${WS}/items/${id}?version=${String(version)}`,
    headers: auth(app),
  })
}

function query(app: FastifyInstance, body: object) {
  return app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/query`,
    headers: auth(app),
    payload: { from: 'h1', limit: 50, ...body },
  })
}

function read(app: FastifyInstance, id: string, qs = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/workspaces/${WS}/items/${id}${qs}`,
    headers: auth(app),
  })
}

function getBacklinks(app: FastifyInstance, id: string, qs = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/workspaces/${WS}/items/${id}/backlinks${qs}`,
    headers: auth(app),
  })
}

async function versionOf(id: string): Promise<number> {
  const row = await db
    .selectFrom('item')
    .select('version')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return row.version
}

/** Link rows from `from`, as `attribute:to`, sorted. */
async function linksFrom(from: string): Promise<string[]> {
  const rows = await db
    .selectFrom('link')
    .select(['attribute_id', 'to_item'])
    .where('workspace_id', '=', WS)
    .where('from_item', '=', from)
    .execute()
  return rows.map((r) => `${r.attribute_id}:${r.to_item}`).sort()
}

type ValueErrorBody = { attributeId: string; code: string; message: string }

function valueErrors(res: Awaited<ReturnType<typeof createRaw>>): ValueErrorBody[] {
  expect(res.statusCode, res.body).toBe(422)
  const body = res.json<{ error: string; errors: ValueErrorBody[] }>()
  expect(body.error).toBe('invalid_values')
  return body.errors
}

describe('link maintenance', () => {
  beforeEach(async () => {
    await create(owner, 'a', 'h1', { title: 'A' })
    await create(owner, 'b', 'h1', { title: 'B' })
    await create(owner, 'x', 'h2', { title2: 'X' })
  })

  it('writes links on create, with the value, in the same transaction', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a', 'b'], cross: ['x'] })
    expect(c.values['rel']).toEqual(['a', 'b'])
    expect(await linksFrom('c')).toEqual(['cross:x', 'rel:a', 'rel:b'])
    // The relation is indexed, one row per linked item.
    const index = await db
      .selectFrom('item_index')
      .select(['txt', 'ord'])
      .where('item_id', '=', 'c')
      .where('attribute_id', '=', 'rel')
      .orderBy('ord')
      .execute()
    expect(index.map((r) => r.txt)).toEqual(['a', 'b'])
  })

  it('replaces the links of touched relations on patch and clears them with null', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a'], cross: ['x'] })
    let res = await patch(owner, 'c', c.version, { rel: ['b'] })
    expect(res.statusCode, res.body).toBe(200)
    // `cross` was not in the patch, so its links stay.
    expect(await linksFrom('c')).toEqual(['cross:x', 'rel:b'])

    res = await patch(owner, 'c', c.version + 1, { rel: null, cross: [] })
    expect(res.statusCode, res.body).toBe(200)
    expect(itemSchema.parse(res.json()).values).toEqual({ num: 3 })
    expect(await linksFrom('c')).toEqual([])
  })

  it('lets an item link to itself', async () => {
    const a = await db
      .selectFrom('item')
      .select('version')
      .where('id', '=', 'a')
      .executeTakeFirstOrThrow()
    const res = await patch(owner, 'a', a.version, { rel: ['a'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(await linksFrom('a')).toEqual(['rel:a'])
  })

  it('refuses a missing target and writes nothing', async () => {
    const errors = valueErrors(await createRaw(owner, 'c', 'h1', { rel: ['a', 'nope'] }))
    expect(errors).toEqual([
      { attributeId: 'rel', code: 'invalid_value', message: 'Item "nope" not found' },
    ])
    const item = await db.selectFrom('item').select('id').where('id', '=', 'c').executeTakeFirst()
    expect(item).toBeUndefined()
    expect(await linksFrom('c')).toEqual([])
  })

  it('refuses a missing target on patch and keeps the old value, links and version', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a'] })
    valueErrors(await patch(owner, 'c', c.version, { rel: ['nope'] }))
    const after = await db
      .selectFrom('item')
      .select(['version', 'values'])
      .where('id', '=', 'c')
      .executeTakeFirstOrThrow()
    expect(after.version).toBe(c.version)
    expect(after.values['rel']).toEqual(['a'])
    expect(await linksFrom('c')).toEqual(['rel:a'])
  })

  it('answers a stale version with 409 and leaves the links alone', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a'] })
    expect((await patch(owner, 'c', c.version, { rel: ['b'] })).statusCode).toBe(200)
    const res = await patch(owner, 'c', c.version, { rel: ['a'] })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ current: Item }>().current.values['rel']).toEqual(['b'])
    expect(await linksFrom('c')).toEqual(['rel:b'])
  })

  it('refuses a cross-hub target unless the attribute allows it (D11)', async () => {
    const errors = valueErrors(await createRaw(owner, 'c', 'h1', { rel: ['x'] }))
    expect(errors).toEqual([
      {
        attributeId: 'rel',
        code: 'invalid_value',
        message: 'Item "x" is in another hub, and this relation does not allow cross-hub links',
      },
    ])
  })

  it("refuses a target outside the relation's target hub", async () => {
    const errors = valueErrors(await createRaw(owner, 'c', 'h1', { cross: ['a'] }))
    expect(errors).toEqual([
      {
        attributeId: 'cross',
        code: 'invalid_value',
        message: `Item "a" is not in this relation's target hub`,
      },
    ])
  })

  it('treats a target in a hub the writer cannot read as missing', async () => {
    await create(insider, 's', 'h3', { title3: 'Secret' })
    // The owner holds no grant on h3 (D45), so `s` is as good as missing to them.
    const errors = valueErrors(await createRaw(owner, 'c', 'h1', { secret: ['s'] }))
    expect(errors).toEqual([
      { attributeId: 'secret', code: 'invalid_value', message: 'Item "s" not found' },
    ])
    // The insider can read h3 and may link it.
    await create(insider, 'c', 'h1', { secret: ['s'] })
    expect(await linksFrom('c')).toEqual(['secret:s'])
  })

  it('keeps the core checks: at most one item on a single relation, no duplicates', async () => {
    let errors = valueErrors(await createRaw(owner, 'c', 'h1', { one: ['a', 'b'] }))
    expect(errors[0]?.attributeId).toBe('one')
    errors = valueErrors(await createRaw(owner, 'c', 'h1', { rel: ['a', 'a'] }))
    expect(errors[0]?.attributeId).toBe('rel')
  })

  it('keeps a stored link to an item the writer cannot read, but refuses a new one', async () => {
    await create(insider, 's', 'h3', { title3: 'Secret' })
    await create(insider, 's2', 'h3', { title3: 'Secret 2' })
    // Linked by the insider; the owner sees the ID but cannot read h3.
    await create(insider, 'c', 'h1', { secret: ['s'], rel: ['a'] })

    // Re-sending the stored ID next to other changes is fine, and the link stays.
    const res = await patch(owner, 'c', await versionOf('c'), { secret: ['s'], rel: ['a', 'b'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(itemSchema.parse(res.json()).values['secret']).toEqual(['s'])
    expect(await linksFrom('c')).toEqual(['rel:a', 'rel:b', 'secret:s'])

    // Adding another unreadable item is refused, and only that ID is named.
    const version = await versionOf('c')
    const errors = valueErrors(await patch(owner, 'c', version, { secret: ['s', 's2'] }))
    expect(errors).toEqual([
      { attributeId: 'secret', code: 'invalid_value', message: 'Item "s2" not found' },
    ])
    expect(await versionOf('c')).toBe(version)
    expect(await linksFrom('c')).toEqual(['rel:a', 'rel:b', 'secret:s'])

    // Stored is per attribute: `s` in `secret` does not make it new-but-allowed elsewhere.
    const other = valueErrors(await patch(owner, 'c', version, { rel: ['a', 's'] }))
    expect(other).toEqual([
      { attributeId: 'rel', code: 'invalid_value', message: 'Item "s" not found' },
    ])
  })

  it('still checks the hub rules for stored IDs', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a'] })
    // A stored ID that breaks the rules (written around the API) is not grandfathered in.
    await db
      .updateTable('item')
      .set({ values: JSON.stringify({ cross: ['a'] }) })
      .where('id', '=', 'c')
      .execute()
    const errors = valueErrors(await patch(owner, 'c', c.version, { cross: ['a'] }))
    expect(errors[0]?.message).toBe(`Item "a" is not in this relation's target hub`)
  })

  it('drops stored IDs of deleted items on patch, but refuses unknown new ones', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a', 'b'], one: ['b'] })
    expect((await remove(owner, 'b', await versionOf('b'))).statusCode).toBe(204)

    // The client sends back the value it read, with a new target added.
    await create(owner, 'd', 'h1')
    let res = await patch(owner, 'c', c.version, { rel: ['a', 'b', 'd'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(itemSchema.parse(res.json()).values['rel']).toEqual(['a', 'd'])
    expect(await linksFrom('c')).toEqual(['rel:a', 'rel:d'])
    const revision = await db
      .selectFrom('revision')
      .select('patch')
      .where('item_id', '=', 'c')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow()
    expect(revision.patch).toEqual({ op: 'update', values: { rel: ['a', 'd'] } })

    // Only stale IDs left: the value is cleared, as `[]` would be.
    res = await patch(owner, 'c', c.version + 1, { one: ['b'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(itemSchema.parse(res.json()).values).not.toHaveProperty('one')

    // A deleted ID that was never stored in this attribute is new, so it is still a 422.
    const errors = valueErrors(await patch(owner, 'c', c.version + 2, { one: ['b'] }))
    expect(errors).toEqual([
      { attributeId: 'one', code: 'invalid_value', message: 'Item "b" not found' },
    ])
  })

  it('refuses a required relation left empty once stale IDs are dropped', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['b'] })
    await db
      .updateTable('folder_attribute')
      .set({ required: true })
      .where('workspace_id', '=', WS)
      .where('folder_id', '=', 'h1')
      .where('attribute_id', '=', 'rel')
      .execute()
    expect((await remove(owner, 'b', await versionOf('b'))).statusCode).toBe(204)

    const errors = valueErrors(await patch(owner, 'c', c.version, { rel: ['b'] }))
    expect(errors).toEqual([
      { attributeId: 'rel', code: 'required', message: 'A value is required' },
    ])
    expect(await versionOf('c')).toBe(c.version)
    const stored = await db
      .selectFrom('item')
      .select('values')
      .where('id', '=', 'c')
      .executeTakeFirstOrThrow()
    expect(stored.values).toMatchObject({ rel: ['b'] })

    // A live target left alongside the stale one is enough.
    const res = await patch(owner, 'c', c.version, { rel: ['b', 'a'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(itemSchema.parse(res.json()).values['rel']).toEqual(['a'])
    expect(await linksFrom('c')).toEqual(['rel:a'])
  })

  it('answers 404 for a patch of a missing item', async () => {
    const res = await patch(owner, 'nope', 1, { rel: ['a'] })
    expect(res.statusCode, res.body).toBe(404)
  })

  it('removes links from and to an item when it is deleted', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a'] })
    const b = await db
      .selectFrom('item')
      .select('version')
      .where('id', '=', 'b')
      .executeTakeFirstOrThrow()
    await patch(owner, 'b', b.version, { rel: ['c'] })
    expect(await linksFrom('b')).toEqual(['rel:c'])

    expect((await remove(owner, 'c', c.version)).statusCode).toBe(204)
    expect(await linksFrom('c')).toEqual([])
    expect(await linksFrom('b')).toEqual([])
    // The value in `b` keeps the ID; with no link left, expand leaves it out (see below).
    const after = await db
      .selectFrom('item')
      .select('values')
      .where('id', '=', 'b')
      .executeTakeFirstOrThrow()
    expect(after.values['rel']).toEqual(['c'])
  })

  it('refuses a stale delete with 409 and keeps the links', async () => {
    const c = await create(owner, 'c', 'h1', { rel: ['a'] })
    await patch(owner, 'c', c.version, { title: 'C' })
    expect((await remove(owner, 'c', c.version)).statusCode).toBe(409)
    expect(await linksFrom('c')).toEqual(['rel:a'])
  })
})

describe('auto ID', () => {
  it('is the item’s seqId, written on create, indexed, and in the revision', async () => {
    const a = await create(owner, 'a', 'h1', { title: 'A' })
    const b = await create(owner, 'b', 'h1')
    expect(a.values['num']).toBe(a.seqId)
    expect(b.values['num']).toBe(b.seqId)
    expect(b.seqId).toBe(a.seqId + 1)

    const revision = await db
      .selectFrom('revision')
      .select('patch')
      .where('item_id', '=', 'a')
      .executeTakeFirstOrThrow()
    expect(revision.patch).toEqual({
      op: 'create',
      folderId: 'h1',
      values: { title: 'A', num: a.seqId },
    })

    const res = await query(owner, { sort: [{ attribute: 'num', direction: 'desc' }] })
    expect(res.statusCode, res.body).toBe(200)
    expect(itemQueryResultSchema.parse(res.json()).items.map((i) => i.id)).toEqual(['b', 'a'])
    const filtered = await query(owner, { where: { attribute: 'num', op: 'eq', value: a.seqId } })
    expect(itemQueryResultSchema.parse(filtered.json()).items.map((i) => i.id)).toEqual(['a'])
  })

  it('cannot be set or cleared by a client', async () => {
    let errors = valueErrors(await createRaw(owner, 'a', 'h1', { num: 7 }))
    expect(errors).toEqual([
      { attributeId: 'num', code: 'read_only', message: 'Assigned by the server' },
    ])
    const a = await create(owner, 'a', 'h1')
    errors = valueErrors(await patch(owner, 'a', a.version, { num: null }))
    expect(errors[0]?.code).toBe('read_only')
  })
})

describe('expand', () => {
  beforeEach(async () => {
    await create(owner, 'a', 'h1', { title: 'A' })
    await create(owner, 'x', 'h2', { title2: 'X' })
    await create(insider, 's', 'h3', { title3: 'Secret' })
    // Linked by someone who can read h3; the owner cannot.
    await create(insider, 'c', 'h1', { title: 'C', rel: ['a'], cross: ['x'], secret: ['s'] })
  })

  it('returns linked items the caller can read and "no access" for the rest', async () => {
    const res = await query(owner, { expand: ['rel', 'cross', 'secret'] })
    expect(res.statusCode, res.body).toBe(200)
    const body = itemQueryResultSchema.parse(res.json())
    expect(Object.keys(body.linked ?? {}).sort()).toEqual(['a', 's', 'x'])
    expect(body.linked?.['a']).toMatchObject({
      access: 'read',
      item: { id: 'a', values: { title: 'A' } },
    })
    expect(body.linked?.['x']).toMatchObject({ access: 'read', item: { id: 'x' } })
    // No values, no hub, nothing but the marker.
    expect(body.linked?.['s']).toEqual({ access: 'none' })
    expect(body.linkedTruncated).toBe(false)
  })

  it('caps the linked items per response and says so', async () => {
    const capped = asOwner({ maxLinkedItems: 2 })
    try {
      let body = itemQueryResultSchema.parse(
        (await query(capped, { expand: ['rel', 'cross', 'secret'] })).json(),
      )
      // The first two by ID.
      expect(Object.keys(body.linked ?? {}).sort()).toEqual(['a', 's'])
      expect(body.linkedTruncated).toBe(true)
      body = itemQueryResultSchema.parse((await query(capped, { expand: ['rel', 'cross'] })).json())
      expect(Object.keys(body.linked ?? {}).sort()).toEqual(['a', 'x'])
      expect(body.linkedTruncated).toBe(false)
    } finally {
      await capped.close()
    }
  })

  it('shows the same link readable to a caller with a grant', async () => {
    const res = await query(insider, { expand: ['secret'] })
    const body = itemQueryResultSchema.parse(res.json())
    expect(Object.keys(body.linked ?? {})).toEqual(['s'])
    expect(body.linked?.['s']).toMatchObject({ access: 'read', item: { id: 's' } })
  })

  it('follows only the attributes asked for', async () => {
    const res = await query(owner, { expand: ['cross'] })
    const { linked } = itemQueryResultSchema.parse(res.json())
    expect(Object.keys(linked ?? {})).toEqual(['x'])
    expect(linked?.['x']).toMatchObject({ access: 'read', item: { id: 'x' } })
  })

  it('leaves out an item that was deleted after it was linked', async () => {
    const x = await db
      .selectFrom('item')
      .select('version')
      .where('id', '=', 'x')
      .executeTakeFirstOrThrow()
    expect((await remove(owner, 'x', x.version)).statusCode).toBe(204)
    const body = itemQueryResultSchema.parse((await query(owner, { expand: ['cross'] })).json())
    expect(body.items.find((i) => i.id === 'c')?.values['cross']).toEqual(['x'])
    expect(body.linked).toEqual({})
  })

  it('has no `linked` without expand, so the M0 page shape is unchanged', async () => {
    const res = await query(owner, {})
    expect(Object.keys(res.json<object>()).sort()).toEqual(['items', 'nextCursor'])
  })

  it('refuses attributes that are not relations of the folder', async () => {
    for (const [expand, fragment] of [
      [['title'], 'only relations can be expanded'],
      [['title3'], 'is not an attribute of this folder'],
    ] as const) {
      const res = await query(owner, { expand })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json<{ message: string }>().message).toContain(fragment)
    }
    expect((await query(owner, { expand: ['rel', 'rel'] })).statusCode).toBe(400)
    expect((await query(owner, { expand: ['rel', 'cross', 'secret', 'one'] })).statusCode).toBe(400)
  })
})

describe('expand on a single item (#73)', () => {
  beforeEach(async () => {
    await create(owner, 'a', 'h1', { title: 'A' })
    await create(owner, 'x', 'h2', { title2: 'X' })
    await create(insider, 's', 'h3', { title3: 'Secret' })
    await create(insider, 'c', 'h1', { title: 'C', rel: ['a'], cross: ['x'], secret: ['s'] })
  })

  it('tells "no access" from "deleted" for a panel opened by direct link', async () => {
    const x = await versionOf('x')
    expect((await remove(owner, 'x', x)).statusCode).toBe(204)

    const res = await read(owner, 'c', '?expand=rel,cross,secret')
    expect(res.statusCode, res.body).toBe(200)
    const body = itemReadSchema.parse(res.json())
    expect(body).toMatchObject({ id: 'c', values: { cross: ['x'], secret: ['s'] } })
    expect(body.linked?.['a']).toMatchObject({ access: 'read', item: { id: 'a' } })
    // Exists, but in a hub the owner has no grant on: a marker and nothing else.
    expect(body.linked?.['s']).toEqual({ access: 'none' })
    // Deleted: the value keeps the ID, `linked` has no entry, and nothing was cut off.
    expect(body.linked).not.toHaveProperty('x')
    expect(body.linkedTruncated).toBe(false)
  })

  it('takes repeated keys too, and follows only the attributes asked for', async () => {
    const body = itemReadSchema.parse(
      (await read(insider, 'c', '?expand=secret&expand=cross')).json(),
    )
    expect(Object.keys(body.linked ?? {}).sort()).toEqual(['s', 'x'])
    expect(body.linked?.['s']).toMatchObject({ access: 'read', item: { id: 's' } })
  })

  it('caps the linked items and says so', async () => {
    const capped = asOwner({ maxLinkedItems: 1 })
    try {
      const body = itemReadSchema.parse((await read(capped, 'c', '?expand=rel,cross')).json())
      expect(Object.keys(body.linked ?? {})).toEqual(['a'])
      expect(body.linkedTruncated).toBe(true)
    } finally {
      await capped.close()
    }
  })

  it('returns the plain item without expand, as before', async () => {
    for (const qs of ['', '?expand=']) {
      const res = await read(owner, 'c', qs)
      expect(res.statusCode, res.body).toBe(200)
      expect(itemSchema.parse(res.json()).id).toBe('c')
    }
  })

  it('refuses expands that break the query rules', async () => {
    for (const [qs, fragment] of [
      ['?expand=title', 'only relations can be expanded'],
      ['?expand=title3', 'is not an attribute of this folder'],
    ] as const) {
      const res = await read(owner, 'c', qs)
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json<{ error: string; message: string }>()).toMatchObject({
        error: 'invalid_request',
        message: expect.stringContaining(fragment) as string,
      })
    }
    for (const qs of ['?expand=rel,rel', '?expand=rel,cross,secret,one', '?expand=r%20l', '?x=1']) {
      expect((await read(owner, 'c', qs)).statusCode, qs).toBe(400)
    }
  })

  it('answers 404 for a missing item and for one in a hidden hub, expand or not', async () => {
    for (const id of ['nope', 's']) {
      for (const qs of ['', '?expand=back']) {
        const res = await read(owner, id, qs)
        expect(res.statusCode, `${id}${qs}`).toBe(404)
        expect(res.json<{ error: string }>().error).toBe('not_found')
      }
    }
  })
})

describe('backlinks', () => {
  beforeEach(async () => {
    await create(owner, 'a', 'h1', { title: 'A' })
    await create(owner, 'b', 'h1', { rel: ['a'], one: ['a'] })
    await create(owner, 'c', 'h1', { rel: ['a'] })
    await create(insider, 's', 'h3', { back: ['a'] })
  })

  it('lists only linking items the caller can read and counts the rest', async () => {
    let res = await getBacklinks(owner, 'a')
    expect(res.statusCode, res.body).toBe(200)
    let body = backlinkPageSchema.parse(res.json())
    expect(body.nextCursor).toBeNull()
    expect(body.items.map((l) => `${l.item.id}:${l.attributeId}`)).toEqual([
      'b:one',
      'b:rel',
      'c:rel',
    ])
    expect(body.items[0]).toMatchObject({ item: { id: 'b', values: { rel: ['a'] } } })
    // `s` in h3 is hidden from the owner: counted, never named.
    expect(body.hidden).toBe(1)
    expect(res.body).not.toContain('"s"')
    expect(res.body).not.toContain('back')

    res = await getBacklinks(insider, 'a')
    body = backlinkPageSchema.parse(res.json())
    expect(body.items.map((l) => `${l.item.id}:${l.attributeId}`)).toEqual([
      'b:one',
      'b:rel',
      'c:rel',
      's:back',
    ])
    expect(body.hidden).toBe(0)
  })

  it('caps the hidden count', async () => {
    await create(insider, 's2', 'h3', { back: ['a'] })
    expect(backlinkPageSchema.parse((await getBacklinks(owner, 'a')).json()).hidden).toBe(2)
    const capped = asOwner({ maxHiddenBacklinks: 1 })
    try {
      const body = backlinkPageSchema.parse((await getBacklinks(capped, 'a')).json())
      expect(body.hidden).toBe(1)
      expect(body.items).toHaveLength(3)
    } finally {
      await capped.close()
    }
  })

  it('pages with a cursor, over readable items only', async () => {
    const pages = async (app: FastifyInstance) => {
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const qs: string = `?limit=1${cursor ? `&cursor=${cursor}` : ''}`
        const res = await getBacklinks(app, 'a', qs)
        expect(res.statusCode, res.body).toBe(200)
        const body = backlinkPageSchema.parse(res.json())
        expect(body.items).toHaveLength(1)
        seen.push(...body.items.map((l) => `${l.item.id}:${l.attributeId}`))
        cursor = body.nextCursor
      } while (cursor)
      return seen
    }
    expect(await pages(insider)).toEqual(['b:one', 'b:rel', 'c:rel', 's:back'])
    // No trailing empty page for the hidden link.
    expect(await pages(owner)).toEqual(['b:one', 'b:rel', 'c:rel'])
  })

  it('answers 404 for a missing item and for one in a hub the caller cannot read', async () => {
    expect((await getBacklinks(owner, 'nope')).statusCode).toBe(404)
    expect((await getBacklinks(owner, 's')).statusCode).toBe(404)
    expect((await getBacklinks(insider, 's')).statusCode).toBe(200)
  })

  it('refuses a bad cursor and limit', async () => {
    expect((await getBacklinks(owner, 'a', '?cursor=bad')).statusCode).toBe(400)
    expect((await getBacklinks(owner, 'a', '?limit=0')).statusCode).toBe(400)
  })
})

describe('readableHubs', () => {
  it('follows can(): a grant is needed even for owners, and non-members read nothing', async () => {
    const subject = (id: string) => loadSubject(db, WS, id)
    const readable = async (id: string, hubs: string[]) =>
      [...(await readableHubs(db, WS, await subject(id), hubs))].sort()
    expect(await readable('owner', ['h1', 'h2', 'h3'])).toEqual(['h1', 'h2'])
    expect(await readable('insider', ['h3'])).toEqual(['h3'])
    expect(await subject('stranger')).toBeNull()
    expect(await readable('stranger', ['h1'])).toEqual([])
    expect(await readable('owner', [])).toEqual([])

    const all = async (id: string) => (await allReadableHubs(db, WS, await subject(id))).sort()
    expect(await all('owner')).toEqual(['h1', 'h2'])
    expect(await all('insider')).toEqual(['h1', 'h2', 'h3'])
    expect(await all('stranger')).toEqual([])
  })
})
