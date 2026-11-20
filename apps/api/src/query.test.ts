import {
  encodeItemCursor,
  itemPageSchema,
  itemQueryResultSchema,
  type Filter,
  type Sort,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { hashAgentSecret, newAgentSecret } from './auth/agent-key.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { encodeCursor } from './http.ts'
import { itemQueryStatement, type ItemQuery } from './items.ts'

// Integration tests for item_index, filters, and sorts (D6, D19, D20) against a real Postgres.

const ACTOR = 'dev-owner'

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let auth: { cookie: string }

/**
 * Hub `h`, one indexed attribute per M0 type (two dates), and `notes`, which is not indexed.
 * `extra` belongs to the hub but is not shown on `h`.
 *
 *     id  title       points  done   due         at (UTC)  stage
 *     a   Apple       3       true   2026-01-01  08:00     todo
 *     b   banana      10      false  2026-03-01  09:00     done
 *     c   50%_off     -1      true   2026-02-01  07:00     doing
 *     d   -           3       -      -           -         -
 *     e   apple pie   -       false  2026-01-01  08:00     todo
 */
const ITEMS: Record<string, Record<string, unknown>> = {
  a: {
    title: 'Apple',
    points: 3,
    done: true,
    due: '2026-01-01',
    at: '2026-11-16T10:00:00+02:00',
    stage: 'todo',
    notes: 'Apple notes',
  },
  b: {
    title: 'banana',
    points: 10,
    done: false,
    due: '2026-03-01',
    at: '2026-11-16T09:00:00Z',
    stage: 'done',
  },
  c: {
    title: '50%_off',
    points: -1,
    done: true,
    due: '2026-02-01',
    at: '2026-11-16T12:00:00+05:00',
    stage: 'doing',
  },
  d: { points: 3 },
  e: {
    title: 'apple pie',
    done: false,
    due: '2026-01-01',
    at: '2026-11-16T08:00:00Z',
    stage: 'todo',
  },
}

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seedWorkspace('w1')
  app = buildApp({ db: appDb })
  for (const [id, values] of Object.entries(ITEMS)) await createIn('w1', id, values)
})

/** Workspace `ws` with hub `h` and the attributes above, and no items. */
async function seedWorkspace(ws: string): Promise<void> {
  await db.insertInto('workspace').values({ id: ws, name: 'W' }).execute()
  await db
    .insertInto('principal')
    .values({ workspace_id: ws, id: ACTOR, kind: 'user', name: 'Dev', workspace_role: 'owner' })
    .execute()
  // Signs in again, so the session also reaches this workspace.
  auth = await sessionCookie(db, ACTOR)
  await db
    .insertInto('folder')
    .values({
      workspace_id: ws,
      id: 'h',
      hub_id: 'h',
      parent_id: null,
      name: 'Hub',
      color: 'blue',
      id_prefix: 'H',
    })
    .execute()
  await db
    .insertInto('hub_grant')
    .values({ workspace_id: ws, hub_id: 'h', principal_id: ACTOR, hub_role: 'hub_admin' })
    .execute()
  const attribute = (id: string, type: string, config: object, indexed = true) => ({
    workspace_id: ws,
    id,
    hub_id: 'h',
    name: id,
    type: type as 'text',
    config: JSON.stringify(config),
    indexed,
  })
  const attributes = [
    attribute('title', 'text', {}),
    attribute('points', 'number', { min: -5, max: 100 }),
    attribute('done', 'boolean', {}),
    attribute('due', 'date', {}),
    attribute('at', 'date', { includeTime: true }),
    attribute('stage', 'select', {
      options: [
        { id: 'todo', label: 'To do' },
        { id: 'doing', label: 'Doing' },
        { id: 'done', label: 'Done' },
      ],
    }),
    attribute('notes', 'text', {}, false),
  ]
  await db
    .insertInto('attribute')
    .values([...attributes, attribute('extra', 'number', {})])
    .execute()
  await db
    .insertInto('folder_attribute')
    .values(
      attributes.map((a, position) => ({
        workspace_id: ws,
        hub_id: 'h',
        folder_id: 'h',
        attribute_id: a.id,
        position,
      })),
    )
    .execute()
}

async function createIn(ws: string, id: string, values: object): Promise<void> {
  const res = await post(`/v1/workspaces/${ws}/items`, { id, folderId: 'h', values })
  expect(res.statusCode, res.body).toBe(201)
}

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

function post(url: string, payload: object) {
  return app.inject({ method: 'POST', url, headers: auth, payload })
}

function query(body: object, ws = 'w1') {
  return post(`/v1/workspaces/${ws}/query`, { from: 'h', limit: 50, ...body })
}

/** IDs in result order. */
async function ids(body: { where?: Filter; sort?: Sort; limit?: number }): Promise<string[]> {
  const res = await query(body)
  expect(res.statusCode, res.body).toBe(200)
  return itemPageSchema.parse(res.json()).items.map((i) => i.id)
}

/** IDs matching a filter, in ID order. */
async function matching(where: Filter): Promise<string[]> {
  return (await ids({ where })).sort()
}

const cond = (attribute: string, op: string, value?: unknown): Filter =>
  (value === undefined ? { attribute, op } : { attribute, op, value }) as Filter

async function expectInvalid(body: object, ...fragments: string[]): Promise<void> {
  const res = await query(body)
  expect(res.statusCode, res.body).toBe(400)
  const json = res.json<{ error: string; message: string }>()
  expect(json.error).toBe('invalid_request')
  for (const fragment of fragments) expect(json.message).toContain(fragment)
}

describe('index writes', () => {
  const rows = (itemId: string) =>
    db
      .selectFrom('item_index')
      .select(['attribute_id', 'ord', 'num', 'txt'])
      .where('workspace_id', '=', 'w1')
      .where('item_id', '=', itemId)
      .orderBy('attribute_id')
      .execute()

  it('writes one row per non-empty indexed value on create, none for unindexed ones', async () => {
    const a = await rows('a')
    expect(a.map((r) => r.attribute_id)).toEqual(['at', 'done', 'due', 'points', 'stage', 'title'])
    expect(a.every((r) => r.ord === 0)).toBe(true)
    expect((await rows('d')).map((r) => r.attribute_id)).toEqual(['points'])
  })

  it('replaces changed values and drops cleared ones on patch', async () => {
    const patch = (version: number, values: object) =>
      app.inject({
        method: 'PATCH',
        url: '/v1/workspaces/w1/items/a',
        headers: auth,
        payload: { version, values },
      })
    expect((await patch(1, { points: 20, title: null })).statusCode).toBe(200)
    expect(await matching(cond('points', 'gt', 10))).toEqual(['a'])
    expect(await matching(cond('title', 'is_empty'))).toEqual(['a', 'd'])
    expect((await rows('a')).find((r) => r.attribute_id === 'points')?.num).toBe(20)

    // A stale version is a conflict and leaves the index as it was.
    expect((await patch(1, { points: 50 })).statusCode).toBe(409)
    expect(await matching(cond('points', 'eq', 20))).toEqual(['a'])
  })

  it('drops an item’s rows when it is deleted', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/workspaces/w1/items/b?version=1',
      headers: auth,
    })
    expect(res.statusCode).toBe(204)
    expect(await rows('b')).toEqual([])
    expect(await matching(cond('done', 'eq', false))).toEqual(['e'])
  })
})

describe('filters', () => {
  it('text: exact eq, case-insensitive search, literal wildcards, negatives match empty', async () => {
    expect(await matching(cond('title', 'eq', 'Apple'))).toEqual(['a'])
    expect(await matching(cond('title', 'eq', 'apple'))).toEqual([])
    expect(await matching(cond('title', 'neq', 'Apple'))).toEqual(['b', 'c', 'd', 'e'])
    expect(await matching(cond('title', 'contains', 'APP'))).toEqual(['a', 'e'])
    expect(await matching(cond('title', 'contains', '%'))).toEqual(['c'])
    expect(await matching(cond('title', 'contains', '_'))).toEqual(['c'])
    expect(await matching(cond('title', 'not_contains', 'app'))).toEqual(['b', 'c', 'd'])
    expect(await matching(cond('title', 'starts_with', 'aP'))).toEqual(['a', 'e'])
    expect(await matching(cond('title', 'starts_with', 'pie'))).toEqual([])
    expect(await matching(cond('title', 'is_empty'))).toEqual(['d'])
    expect(await matching(cond('title', 'is_not_empty'))).toEqual(['a', 'b', 'c', 'e'])
  })

  it('number: comparisons, and bounds outside the attribute’s min and max', async () => {
    expect(await matching(cond('points', 'eq', 3))).toEqual(['a', 'd'])
    expect(await matching(cond('points', 'neq', 3))).toEqual(['b', 'c', 'e'])
    expect(await matching(cond('points', 'gt', 3))).toEqual(['b'])
    expect(await matching(cond('points', 'gte', 3))).toEqual(['a', 'b', 'd'])
    expect(await matching(cond('points', 'lt', 3))).toEqual(['c'])
    expect(await matching(cond('points', 'lte', -1))).toEqual(['c'])
    expect(await matching(cond('points', 'gt', -1000))).toEqual(['a', 'b', 'c', 'd'])
    expect(await matching(cond('points', 'is_empty'))).toEqual(['e'])
    expect(await matching(cond('points', 'is_not_empty'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('boolean: eq, neq, and empty', async () => {
    expect(await matching(cond('done', 'eq', true))).toEqual(['a', 'c'])
    expect(await matching(cond('done', 'eq', false))).toEqual(['b', 'e'])
    expect(await matching(cond('done', 'neq', true))).toEqual(['b', 'd', 'e'])
    expect(await matching(cond('done', 'is_empty'))).toEqual(['d'])
    expect(await matching(cond('done', 'is_not_empty'))).toEqual(['a', 'b', 'c', 'e'])
  })

  it('date: calendar dates, and date-times compared by instant across offsets', async () => {
    expect(await matching(cond('due', 'eq', '2026-01-01'))).toEqual(['a', 'e'])
    expect(await matching(cond('due', 'neq', '2026-01-01'))).toEqual(['b', 'c', 'd'])
    expect(await matching(cond('due', 'gt', '2026-01-01'))).toEqual(['b', 'c'])
    expect(await matching(cond('due', 'gte', '2026-02-01'))).toEqual(['b', 'c'])
    expect(await matching(cond('due', 'lt', '2026-02-01'))).toEqual(['a', 'e'])
    expect(await matching(cond('due', 'lte', '2026-02-01'))).toEqual(['a', 'c', 'e'])
    expect(await matching(cond('due', 'is_empty'))).toEqual(['d'])
    expect(await matching(cond('at', 'eq', '2026-11-16T10:00:00+02:00'))).toEqual(['a', 'e'])
    expect(await matching(cond('at', 'eq', '2026-11-16T08:00:00Z'))).toEqual(['a', 'e'])
    expect(await matching(cond('at', 'lt', '2026-11-16T08:30:00Z'))).toEqual(['a', 'c', 'e'])
    expect(await matching(cond('at', 'gt', '2026-11-16T12:00:00+04:00'))).toEqual(['b'])
    expect(await matching(cond('at', 'is_not_empty'))).toEqual(['a', 'b', 'c', 'e'])
  })

  it('select: eq, neq, in, not_in, and empty', async () => {
    expect(await matching(cond('stage', 'eq', 'todo'))).toEqual(['a', 'e'])
    expect(await matching(cond('stage', 'neq', 'todo'))).toEqual(['b', 'c', 'd'])
    expect(await matching(cond('stage', 'in', ['doing', 'done']))).toEqual(['b', 'c'])
    expect(await matching(cond('stage', 'not_in', ['todo']))).toEqual(['b', 'c', 'd'])
    expect(await matching(cond('stage', 'is_empty'))).toEqual(['d'])
  })

  it('combines conditions with nested and and or', async () => {
    const where: Filter = {
      or: [
        { and: [cond('done', 'eq', true), cond('points', 'gt', 0)] },
        cond('stage', 'eq', 'done'),
      ],
    }
    expect(await matching(where)).toEqual(['a', 'b'])
    expect(await matching({ and: [] })).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(await matching({ or: [] })).toEqual([])
  })

  it('rejects unindexed, unknown, and other-folder attributes, naming them', async () => {
    await expectInvalid({ where: cond('notes', 'eq', 'x') }, 'notes', 'not indexed')
    await expectInvalid({ where: cond('nope', 'eq', 'x') }, 'nope', 'not an attribute')
    await expectInvalid({ where: cond('extra', 'eq', 1) }, 'extra', 'not an attribute')
    await expectInvalid({ sort: [{ attribute: 'notes' }] }, 'sort.0', 'notes', 'not indexed')
  })

  it('rejects an operator the type does not support, listing the ones it does', async () => {
    await expectInvalid({ where: cond('points', 'contains', '3') }, 'contains', 'points', 'eq, neq')
    await expectInvalid({ where: cond('stage', 'gt', 'todo') }, 'gt', 'stage')
    await expectInvalid({ where: cond('done', 'in', [true]) }, 'in', 'done')
    await expectInvalid({ where: cond('title', 'like', 'x') })
  })

  it('rejects operands that do not fit the type or the operator', async () => {
    await expectInvalid({ where: cond('points', 'eq', '3') }, 'where.value', 'points')
    await expectInvalid({ where: cond('due', 'eq', '2026-02-30') }, 'due')
    await expectInvalid({ where: cond('due', 'gt', '2026-01-01T00:00:00Z') }, 'due')
    await expectInvalid({ where: cond('at', 'gt', '2026-01-01T00:00:00') }, 'at')
    await expectInvalid({ where: cond('stage', 'eq', 'To do') }, 'stage', 'Unknown option')
    await expectInvalid({ where: cond('stage', 'in', ['todo', 'nope']) }, 'value 1')
    await expectInvalid({ where: cond('stage', 'in', 'todo') }, 'non-empty array')
    await expectInvalid({ where: cond('stage', 'in', []) }, 'non-empty array')
    await expectInvalid({ where: cond('title', 'eq', '') }, 'is_empty')
    await expectInvalid({ where: cond('title', 'contains', '') }, 'non-empty string')
    await expectInvalid({ where: cond('title', 'is_empty', 'x') }, 'takes no value')
    await expectInvalid({ where: cond('points', 'gt') }, 'needs a value')
  })

  it('reports every problem at once, with its path', async () => {
    await expectInvalid(
      { where: { and: [cond('notes', 'eq', 'x'), { or: [cond('points', 'eq', 'x')] }] } },
      'where.and.0',
      'where.and.1.or.0.value',
    )
  })

  it('bounds the size and depth of the filter tree and the sort list', async () => {
    const many = Array.from({ length: 21 }, () => cond('points', 'eq', 1))
    await expectInvalid({ where: { and: many } })
    await expectInvalid(
      { where: { or: [{ and: many.slice(0, 11) }, { and: many.slice(11) }] } },
      'At most 20',
    )
    const deep: Filter = { and: [{ or: [{ and: [cond('points', 'eq', 1)] }] }] }
    await expectInvalid({ where: deep }, 'levels deep')
    await expectInvalid({
      sort: [
        { attribute: 'title' },
        { attribute: 'points' },
        { attribute: 'done' },
        { attribute: 'due' },
      ],
    })
    await expectInvalid({ sort: [{ attribute: 'title' }, { attribute: 'title' }] }, 'once')
    await expectInvalid(
      {
        where: cond(
          'stage',
          'in',
          Array.from({ length: 101 }, () => 'todo'),
        ),
      },
      '100',
    )
  })
})

/** Every sort under test, with the expected order of all five items. */
const SORTS: [Sort, string[]][] = [
  // Lower-cased text order; digits before letters. Empty values last in both directions.
  [[{ attribute: 'title' }], ['c', 'a', 'e', 'b', 'd']],
  [[{ attribute: 'title', direction: 'desc' }], ['b', 'e', 'a', 'c', 'd']],
  // Ties (a and d both 3) break on the item ID.
  [[{ attribute: 'points' }], ['c', 'a', 'd', 'b', 'e']],
  [[{ attribute: 'points', direction: 'desc' }], ['b', 'a', 'd', 'c', 'e']],
  [[{ attribute: 'done' }], ['b', 'e', 'a', 'c', 'd']],
  [[{ attribute: 'due', direction: 'desc' }], ['b', 'c', 'a', 'e', 'd']],
  [[{ attribute: 'at' }], ['c', 'a', 'e', 'b', 'd']],
  // Option order, not option ID order.
  [[{ attribute: 'stage' }], ['a', 'e', 'c', 'b', 'd']],
  [[{ attribute: 'stage', direction: 'desc' }], ['b', 'c', 'a', 'e', 'd']],
  [
    [{ attribute: 'stage' }, { attribute: 'points', direction: 'desc' }],
    ['a', 'e', 'c', 'b', 'd'],
  ],
  [
    [{ attribute: 'due' }, { attribute: 'title', direction: 'desc' }],
    ['e', 'a', 'c', 'b', 'd'],
  ],
]

describe('sorting', () => {
  it.each(SORTS)('orders by %j', async (sort, expected) => {
    expect(await ids({ sort })).toEqual(expected)
  })

  it('sorts a select value whose option was deleted after every option', async () => {
    await db
      .updateTable('attribute')
      .set({ config: JSON.stringify({ options: [{ id: 'done', label: 'Done' }] }) })
      .where('id', '=', 'stage')
      .execute()
    expect(await ids({ sort: [{ attribute: 'stage' }] })).toEqual(['b', 'a', 'c', 'e', 'd'])
  })
})

describe('paging', () => {
  async function allPages(body: { where?: Filter; sort?: Sort }, limit: number): Promise<string[]> {
    const seen: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 20; pages++) {
      const res = await query({ ...body, limit, cursor })
      expect(res.statusCode, res.body).toBe(200)
      const page = itemPageSchema.parse(res.json())
      expect(page.items.length).toBeLessThanOrEqual(limit)
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
      if (!cursor) return seen
    }
    throw new Error('paging did not end')
  }

  it.each(SORTS)(
    'pages %j without skipping or repeating, across ties and empties',
    async (sort, expected) => {
      for (const limit of [1, 2, 3]) expect(await allPages({ sort }, limit)).toEqual(expected)
    },
  )

  it('pages a filtered, sorted query', async () => {
    const where = cond('points', 'is_not_empty')
    expect(
      await allPages({ where, sort: [{ attribute: 'points', direction: 'desc' }] }, 1),
    ).toEqual(['b', 'a', 'd', 'c'])
  })

  it('pages the default order, newest update first', async () => {
    expect(await allPages({}, 2)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  it('rejects a cursor that does not match the sort', async () => {
    const res = await query({ limit: 1 })
    const { nextCursor } = itemPageSchema.parse(res.json())
    await expectInvalid(
      { sort: [{ attribute: 'points' }], cursor: nextCursor },
      'This cursor is from the updated order',
    )
    // A cursor from before #168, with no order recorded.
    await expectInvalid(
      { sort: [{ attribute: 'points' }], cursor: encodeCursor(['x', 'a']) },
      'Invalid cursor',
    )
    // The right order, but keys of the wrong type for this sort.
    await expectInvalid(
      {
        sort: [{ attribute: 'points' }],
        cursor: encodeItemCursor({ order: 'sort', after: ['x', 'a'] }),
      },
      'Invalid cursor',
    )
    // A sort cursor under the default order.
    const sorted = await query({ sort: [{ attribute: 'points' }], limit: 1 })
    await expectInvalid(
      { cursor: itemPageSchema.parse(sorted.json()).nextCursor },
      'This cursor is from the sort order',
    )
  })
})

/** The result of a query that must succeed, checked against core's response schema. */
async function result(body: object, ws = 'w1') {
  const res = await query(body, ws)
  expect(res.statusCode, res.body).toBe(200)
  return itemQueryResultSchema.parse(res.json())
}

function patchItem(id: string, version: number, values: object) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/w1/items/${id}`,
    headers: auth,
    payload: { version, values },
  })
}

describe('the number order (D61)', () => {
  it('lists newest item number first, and an edit does not move the row', async () => {
    const numbers = async () =>
      (await result({ order: 'number' })).items.map((i) => `${i.id}${String(i.seqId)}`)
    expect(await numbers()).toEqual(['e5', 'd4', 'c3', 'b2', 'a1'])
    expect((await patchItem('a', 1, { points: 7 })).statusCode).toBe(200)
    expect(await numbers()).toEqual(['e5', 'd4', 'c3', 'b2', 'a1'])
    // The updated order does move it.
    expect((await result({})).items.map((i) => i.id)).toEqual(['a', 'e', 'd', 'c', 'b'])
  })

  it('pages by a cursor on the item number alone, and refuses one from another order', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 5; pages++) {
      const page = await result({ order: 'number', limit: 2, cursor })
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a'])

    const first = await result({ order: 'number', limit: 2 })
    expect(first.nextCursor).toBe(encodeItemCursor({ order: 'number', after: [4] }))
    await expectInvalid({ cursor: first.nextCursor }, 'This cursor is from the number order')
    const updated = await result({ limit: 2 })
    await expectInvalid(
      { order: 'number', cursor: updated.nextCursor },
      'This cursor is from the updated order',
    )
    await expectInvalid({ order: 'number', sort: [{ attribute: 'points' }] }, 'order')
  })

  it('keeps the number order apart per folder and per workspace', async () => {
    await seedWorkspace('w2')
    await createIn('w2', 'z', { title: 'Zebra' })
    expect((await result({ order: 'number' }, 'w2')).items.map((i) => i.id)).toEqual(['z'])
    expect((await result({ order: 'number' })).items).toHaveLength(5)
  })
})

describe('windows by offset (D61)', () => {
  it('skips `offset` rows in each order, with a cursor that carries on after the window', async () => {
    const window = await result({ order: 'number', offset: 1, limit: 2 })
    expect(window.items.map((i) => i.id)).toEqual(['d', 'c'])
    const next = await result({ order: 'number', limit: 2, cursor: window.nextCursor })
    expect(next.items.map((i) => i.id)).toEqual(['b', 'a'])

    expect((await result({ offset: 3, limit: 5 })).items.map((i) => i.id)).toEqual(['b', 'a'])
    const sorted = await result({ sort: [{ attribute: 'points' }], offset: 2, limit: 2 })
    expect(sorted.items.map((i) => i.id)).toEqual(['d', 'b'])
    const filtered = await result({
      where: cond('done', 'is_not_empty'),
      sort: [{ attribute: 'title' }],
      offset: 1,
      limit: 2,
    })
    expect(filtered.items.map((i) => i.id)).toEqual(['a', 'e'])
  })

  it('answers an empty window past the end, and offset 0 like no offset', async () => {
    const past = await result({ order: 'number', offset: 5, limit: 10 })
    expect(past).toMatchObject({ items: [], nextCursor: null })
    const zero = await result({ order: 'number', offset: 0, limit: 2 })
    expect(zero).toEqual(await result({ order: 'number', limit: 2 }))
  })

  it('refuses an offset with a cursor, a negative one, or one over 100,000', async () => {
    const { nextCursor } = await result({ limit: 1 })
    await expectInvalid({ offset: 1, cursor: nextCursor }, 'offset or by cursor')
    await expectInvalid({ offset: -1 })
    await expectInvalid({ offset: 100_001 })
    await expectInvalid({ offset: 1.5 })
    expect((await result({ offset: 100_000 })).items).toEqual([])
  })
})

describe('total (D61)', () => {
  it('is the folder’s item count with no `where`, and follows creates and deletes', async () => {
    expect((await result({ count: true, limit: 1 })).total).toBe(5)
    expect((await result({ limit: 1 })).total).toBeUndefined()
    await createIn('w1', 'f', { title: 'Fig' })
    expect((await result({ order: 'number', count: true, limit: 1 })).total).toBe(6)
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/workspaces/w1/items/b?version=1',
      headers: auth,
    })
    expect(res.statusCode).toBe(204)
    expect((await result({ count: true, offset: 4, limit: 1 })).total).toBe(5)
  })

  it('reads the counters, not the items, when there is no `where`', async () => {
    // A counter set out of step with the items shows where the total comes from.
    await db.updateTable('folder').set({ item_count: 42 }).where('id', '=', 'h').execute()
    expect((await result({ count: true })).total).toBe(42)
    // With a `where`, even one that matches everything, the items are counted.
    expect((await result({ count: true, where: { and: [] } })).total).toBe(5)
  })

  it('counts the items that pass `where`, over all pages', async () => {
    const page = await result({ where: cond('points', 'gte', 3), count: true, limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(3)
    const sorted = await result({
      where: cond('title', 'contains', 'apple'),
      sort: [{ attribute: 'title', direction: 'desc' }],
      count: true,
      offset: 5,
    })
    expect(sorted).toMatchObject({ items: [], total: 2 })
    expect((await result({ where: { or: [] }, count: true })).total).toBe(0)
  })

  it('counts a hub’s own items, not those in its folders, and each folder its own', async () => {
    const folder = (id: string, parent: string) =>
      db
        .insertInto('folder')
        .values({
          workspace_id: 'w1',
          id,
          hub_id: 'h',
          parent_id: parent,
          name: id,
          color: 'blue',
          id_prefix: 'H',
        })
        .execute()
    await folder('sub', 'h')
    await folder('deep', 'sub')
    const createInFolder = async (id: string, folderId: string) => {
      const res = await post('/v1/workspaces/w1/items', { id, folderId, values: {} })
      expect(res.statusCode, res.body).toBe(201)
    }
    await createInFolder('s1', 'sub')
    await createInFolder('s2', 'sub')
    await createInFolder('d1', 'deep')

    const total = async (from: string) => {
      const page = await result({ from, count: true, order: 'number' })
      expect(page.total).toBe(page.items.length)
      return page.total
    }
    expect(await total('h')).toBe(5)
    expect(await total('sub')).toBe(2)
    expect(await total('deep')).toBe(1)
  })

  it('counts every page from the window itself, the same on a later page and past the end', async () => {
    const where = cond('points', 'is_not_empty')
    const first = await result({ where, count: true, limit: 1 })
    expect(first.total).toBe(4)
    const second = await result({ where, count: true, limit: 1, cursor: first.nextCursor })
    expect(second.items.map((i) => i.id)).toEqual(['c'])
    expect(second.total).toBe(4)
    expect((await result({ where, count: true, order: 'number', offset: 2 })).total).toBe(4)
    expect((await result({ where, count: true, offset: 4 })).total).toBe(4)
  })

  it('gives a viewer and an agent key the owner’s total, and a caller without a grant 404', async () => {
    await db
      .insertInto('folder')
      .values({
        workspace_id: 'w1',
        id: 'sub',
        hub_id: 'h',
        parent_id: 'h',
        name: 'sub',
        color: 'blue',
        id_prefix: 'H',
      })
      .execute()
    const res = await post('/v1/workspaces/w1/items', { id: 's1', folderId: 'sub', values: {} })
    expect(res.statusCode, res.body).toBe(201)

    await db
      .insertInto('principal')
      .values([
        { workspace_id: 'w1', id: 'vw', kind: 'user', name: 'Viewer', workspace_role: 'viewer' },
        { workspace_id: 'w1', id: 'mem', kind: 'user', name: 'Member', workspace_role: 'member' },
        { workspace_id: 'w1', id: 'bot', kind: 'agent', name: 'Bot', workspace_role: 'member' },
      ])
      .execute()
    await db
      .insertInto('hub_grant')
      .values([
        { workspace_id: 'w1', hub_id: 'h', principal_id: 'vw', hub_role: 'viewer' },
        {
          workspace_id: 'w1',
          hub_id: 'h',
          principal_id: 'bot',
          principal_kind: 'agent',
          hub_role: 'editor',
        },
      ])
      .execute()
    const secret = newAgentSecret()
    await db
      .insertInto('agent_key')
      .values({
        workspace_id: 'w1',
        principal_id: 'bot',
        secret_hash: hashAgentSecret(secret),
        created_by: ACTOR,
        expires_at: null,
      })
      .execute()

    const callers: Record<string, Record<string, string>> = {
      owner: auth,
      viewer: await sessionCookie(db, 'vw'),
      agent: { authorization: `Bearer ${secret}` },
    }
    const asCaller = (headers: Record<string, string>, body: object) =>
      app.inject({
        method: 'POST',
        url: '/v1/workspaces/w1/query',
        headers,
        payload: { from: 'h', limit: 50, count: true, ...body },
      })
    for (const [name, headers] of Object.entries(callers)) {
      const totals = []
      for (const body of [{}, { from: 'sub' }, { where: cond('points', 'eq', 3) }]) {
        const page = await asCaller(headers, body)
        expect(page.statusCode, `${name}: ${page.body}`).toBe(200)
        totals.push(itemQueryResultSchema.parse(page.json()).total)
      }
      expect(totals, name).toEqual([5, 1, 2])
    }

    const denied = await asCaller(await sessionCookie(db, 'mem'), {})
    expect(denied.statusCode).toBe(404)
    expect(denied.json()).not.toHaveProperty('total')
  })

  it('answers 404 for a folder in another workspace, and counts only its own workspace', async () => {
    await seedWorkspace('w2')
    await createIn('w2', 'z', { points: 3 })
    expect((await result({ count: true }, 'w2')).total).toBe(1)
    expect((await result({ count: true, where: cond('points', 'eq', 3) }, 'w2')).total).toBe(1)
    const res = await query({ from: 'nope', count: true })
    expect(res.statusCode).toBe(404)
  })
})

describe('workspace isolation', () => {
  it('matches only the queried workspace’s rows, even with the same folder, attribute, and item IDs', async () => {
    await seedWorkspace('w2')
    await createIn('w2', 'a', { title: 'Zebra', points: 99 })
    await createIn('w2', 'z', { title: 'Apple', points: 3 })
    const idsIn = async (ws: string, body: object) => {
      const res = await query(body, ws)
      expect(res.statusCode, res.body).toBe(200)
      return itemPageSchema.parse(res.json()).items.map((i) => `${i.workspaceId}/${i.id}`)
    }
    expect(await idsIn('w2', {})).toEqual(['w2/z', 'w2/a'])
    expect(await idsIn('w2', { where: cond('title', 'contains', 'apple') })).toEqual(['w2/z'])
    expect(await idsIn('w2', { where: cond('points', 'eq', 3) })).toEqual(['w2/z'])
    expect(await idsIn('w2', { where: cond('done', 'is_not_empty') })).toEqual([])
    expect(await idsIn('w1', { where: cond('title', 'eq', 'Zebra') })).toEqual([])
    expect(await idsIn('w2', { sort: [{ attribute: 'points', direction: 'desc' }] })).toEqual([
      'w2/a',
      'w2/z',
    ])
  })
})

describe('query plans (D20)', () => {
  /**
   * EXPLAIN of one page, with sorting priced out so only an index can supply the order. This
   * proves the SQL can be served by the index at any offset; which plan Postgres picks on a
   * real database is checked in query-window.test.ts. It runs as the owner, so the plan shows
   * the index shape, not the `item_read` filter row-level security adds for the API's role.
   */
  async function plan(query: Partial<ItemQuery>): Promise<string> {
    const full: ItemQuery = { from: 'h', where: null, sort: [], limit: 50, cursor: null, ...query }
    const { statement } = await itemQueryStatement(db, 'w1', full)
    return db.transaction().execute(async (trx) => {
      await sql`SET LOCAL enable_sort = off`.execute(trx)
      await sql`SET LOCAL enable_seqscan = off`.execute(trx)
      const { rows } = await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${statement}`.execute(trx)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
  }

  it('serves the default order from item_folder_updated_idx without a sort, on every page', async () => {
    const first = await plan({})
    expect(first).toContain('item_folder_updated_idx')
    expect(first).not.toMatch(/Sort/)

    const res = await query({ limit: 2 })
    const { nextCursor } = itemPageSchema.parse(res.json())
    const next = await plan({ limit: 2, cursor: nextCursor })
    expect(next).toContain('item_folder_updated_idx')
    expect(next).not.toMatch(/Sort/)
  })

  it('serves the number order from item_folder_number_idx without a sort, on every page', async () => {
    const first = await plan({ order: 'number' })
    expect(first).toContain('item_folder_number_idx')
    expect(first).not.toMatch(/Sort/)

    const res = await query({ order: 'number', limit: 2 })
    const { nextCursor } = itemPageSchema.parse(res.json())
    const next = await plan({ order: 'number', limit: 2, cursor: nextCursor })
    expect(next).toContain('item_folder_number_idx')
    expect(next).toMatch(/Index Cond: .*seq_id < /)
    expect(next).not.toMatch(/Sort/)
  })

  it.each(['updated', 'number'] as const)(
    'walks the index for an offset window in the %s order, at any depth',
    async (order) => {
      for (const offset of [1, 49_800, 100_000]) {
        const window = await plan({ order, offset, limit: 200 })
        expect(window).toContain(`item_folder_${order}_idx`)
        expect(window).not.toMatch(/Sort/)
      }
    },
  )
})
