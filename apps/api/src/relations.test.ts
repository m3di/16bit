import {
  backlinkPageSchema,
  itemQueryResultSchema,
  itemSchema,
  type HubRole,
  type Item,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSubject, readableHubs } from './access.ts'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'

// Relations, the link table, auto IDs, expand and backlinks (#47, D7, D11) on a real Postgres.
//
// Workspace w1, three hubs:
//   h1  "Work":    title, rel (-> h1), cross (-> h2, crossHub), secret (-> h3, crossHub),
//                  one (-> h1, single), num (auto ID, indexed)
//   h2  "Other":   title
//   h3  "Hidden":  title, back (-> h1, crossHub)
// Principals: `owner` (workspace owner) holds hub_admin on h1 and h2 and nothing on h3, so h3 is
// hidden from them (D45). `insider` (member) holds editor on h1, h2 and h3.

const KEY = 'test-key'
const WS = 'w1'

let db: Kysely<Database>
let drop: () => Promise<void>
let owner: FastifyInstance
let insider: FastifyInstance

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  await seed()
  owner = buildApp({ db, devApiKey: KEY, devPrincipalId: 'owner' })
  insider = buildApp({ db, devApiKey: KEY, devPrincipalId: 'insider' })
})

afterEach(async () => {
  await owner.close()
  await insider.close()
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

const auth = { authorization: `Bearer ${KEY}` }

async function create(
  app: FastifyInstance,
  id: string,
  folderId: string,
  values: object = {},
): Promise<Item> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/items`,
    headers: auth,
    payload: { id, folderId, values },
  })
  expect(res.statusCode, res.body).toBe(201)
  return itemSchema.parse(res.json())
}

function createRaw(app: FastifyInstance, id: string, folderId: string, values: object) {
  return app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/items`,
    headers: auth,
    payload: { id, folderId, values },
  })
}

function patch(app: FastifyInstance, id: string, version: number, values: object) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${WS}/items/${id}`,
    headers: auth,
    payload: { version, values },
  })
}

function remove(app: FastifyInstance, id: string, version: number) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/workspaces/${WS}/items/${id}?version=${String(version)}`,
    headers: auth,
  })
}

function query(app: FastifyInstance, body: object) {
  return app.inject({
    method: 'POST',
    url: `/v1/workspaces/${WS}/query`,
    headers: auth,
    payload: { from: 'h1', limit: 50, ...body },
  })
}

function getBacklinks(app: FastifyInstance, id: string, qs = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/workspaces/${WS}/items/${id}/backlinks${qs}`,
    headers: auth,
  })
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

  it('refuses a target outside the relation’s target hub', async () => {
    const errors = valueErrors(await createRaw(owner, 'c', 'h1', { cross: ['a'] }))
    expect(errors).toEqual([
      {
        attributeId: 'cross',
        code: 'invalid_value',
        message: 'Item "a" is not in this relation’s target hub'.replace('’', "'"),
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

describe('backlinks', () => {
  beforeEach(async () => {
    await create(owner, 'a', 'h1', { title: 'A' })
    await create(owner, 'b', 'h1', { rel: ['a'], one: ['a'] })
    await create(owner, 'c', 'h1', { rel: ['a'] })
    await create(insider, 's', 'h3', { back: ['a'] })
  })

  it('lists linking items, with "no access" for hubs the caller cannot read', async () => {
    const res = await getBacklinks(owner, 'a')
    expect(res.statusCode, res.body).toBe(200)
    const body = backlinkPageSchema.parse(res.json())
    expect(body.nextCursor).toBeNull()
    expect(body.items.map((l) => `${l.itemId}:${l.attributeId}:${l.access}`)).toEqual([
      'b:one:read',
      'b:rel:read',
      'c:rel:read',
      's:back:none',
    ])
    expect(body.items[3]).toEqual({ access: 'none', itemId: 's', attributeId: 'back' })
    expect(body.items[0]).toMatchObject({ item: { id: 'b' } })
  })

  it('pages with a cursor', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const qs: string = `?limit=1${cursor ? `&cursor=${cursor}` : ''}`
      const res = await getBacklinks(insider, 'a', qs)
      expect(res.statusCode, res.body).toBe(200)
      const body = backlinkPageSchema.parse(res.json())
      expect(body.items).toHaveLength(1)
      seen.push(...body.items.map((l) => `${l.itemId}:${l.attributeId}:${l.access}`))
      cursor = body.nextCursor
    } while (cursor)
    expect(seen).toEqual(['b:one:read', 'b:rel:read', 'c:rel:read', 's:back:read'])
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
  })
})
