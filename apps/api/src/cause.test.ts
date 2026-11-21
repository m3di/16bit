import {
  apiErrorSchema,
  changesPageSchema,
  createdAgentKeySchema,
  itemWriteResultSchema,
  revisionPageSchema,
  type HubRole,
  type Item,
  type ItemCause,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'

// Causes on item writes (D63, #197): stored on the revision, returned on `GET /changes` and
// the item history read, refused at their limits, and kept through a retry (D59). Against a
// real Postgres under row-level security.

const WS = 'w1'

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
const cookies = new Map<string, string>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  for (const p of ['own', 'ed', 'e1', 'vw']) cookies.set(p, (await sessionCookie(db, p)).cookie)
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * Hubs h1 and h2, each with a text attribute (t1, t2). `own` (owner) is hub admin of both, `ed`
 * an editor of both, `e1` an editor of h1 only, `vw` a viewer of h1 only.
 */
async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: WS, name: 'W' }).execute()
  await db
    .insertInto('principal')
    .values(
      (['own', 'ed', 'e1', 'vw'] as const).map((id) => ({
        workspace_id: WS,
        id,
        kind: 'user' as const,
        name: id,
        workspace_role: id === 'own' ? ('owner' as const) : ('member' as const),
      })),
    )
    .execute()
  for (const [hub, prefix, attribute] of [
    ['h1', 'ONE', 't1'],
    ['h2', 'TWO', 't2'],
  ] as const) {
    await db
      .insertInto('folder')
      .values({
        workspace_id: WS,
        id: hub,
        hub_id: hub,
        parent_id: null,
        name: hub,
        color: 'blue',
        id_prefix: prefix,
      })
      .execute()
    await db
      .insertInto('attribute')
      .values({
        workspace_id: WS,
        id: attribute,
        hub_id: hub,
        name: 'T',
        type: 'text',
        config: '{}',
      })
      .execute()
    await db
      .insertInto('folder_attribute')
      .values({
        workspace_id: WS,
        hub_id: hub,
        folder_id: hub,
        attribute_id: attribute,
        position: 0,
      })
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
      grant('h1', 'own', 'hub_admin'),
      grant('h2', 'own', 'hub_admin'),
      grant('h1', 'ed', 'editor'),
      grant('h2', 'ed', 'editor'),
      grant('h1', 'e1', 'editor'),
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

const titleOf = (hub: string) => (hub === 'h1' ? 't1' : 't2')

async function create(who: string, hub: string, title: string, extra: object = {}) {
  const res = await as(who, 'POST', '/items', {
    folderId: hub,
    values: { [titleOf(hub)]: title },
    ...extra,
  })
  expect(res.statusCode, res.body).toBe(201)
  return itemWriteResultSchema.parse(res.json())
}

async function patch(who: string, item: Item, title: string, extra: object = {}) {
  const res = await as(who, 'PATCH', `/items/${item.id}`, {
    version: item.version,
    values: { [titleOf(item.hubId)]: title },
    ...extra,
  })
  expect(res.statusCode, res.body).toBe(200)
  return itemWriteResultSchema.parse(res.json())
}

async function history(who: string, itemId: string, query = '') {
  const res = await as(who, 'GET', `/items/${itemId}/revisions${query}`)
  expect(res.statusCode, res.body).toBe(200)
  return revisionPageSchema.parse(res.json())
}

const revisionCount = async () =>
  Number(
    (
      await db
        .selectFrom('revision')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  )

const errorOf = (body: unknown) => apiErrorSchema.parse(body)

const URL_A = 'https://ci.example.com/runs/1'
const URL_B = 'http://docs.example.com/page'

describe('cause on item writes (D63)', () => {
  it('stores the cause of a create, patch and delete on its revision', async () => {
    const a = await create('ed', 'h1', 'A', { cause: { note: '  from the CI run  ' } })
    const a2 = await patch('ed', a, 'A2', {
      cause: { evidence: [URL_A, URL_B], causedBy: a.seq },
    })
    const b = await create('ed', 'h1', 'B')
    const del = await as('ed', 'DELETE', `/items/${a.id}?version=${String(a2.version)}`, {
      cause: { note: 'superseded', causedBy: b.seq },
    })
    expect(del.statusCode, del.body).toBe(204)

    const rows = await db
      .selectFrom('revision')
      .select(['seq', 'item_id', 'cause'])
      .orderBy('seq')
      .execute()
    expect(rows).toEqual([
      { seq: a.seq, item_id: a.id, cause: { note: 'from the CI run' } },
      { seq: a2.seq, item_id: a.id, cause: { evidence: [URL_A, URL_B], causedBy: a.seq } },
      { seq: b.seq, item_id: b.id, cause: null },
      { seq: b.seq + 1, item_id: a.id, cause: { note: 'superseded', causedBy: b.seq } },
    ])
  })

  it('deletes without a body, and with an empty one, as before', async () => {
    const a = await create('ed', 'h1', 'A')
    const b = await create('ed', 'h1', 'B')
    expect((await as('ed', 'DELETE', `/items/${a.id}?version=1`)).statusCode).toBe(204)
    expect((await as('ed', 'DELETE', `/items/${b.id}?version=1`, {})).statusCode).toBe(204)
    const causes = await db.selectFrom('revision').select('cause').execute()
    expect(causes.every((r) => r.cause === null)).toBe(true)
  })

  it('returns the latest revision’s cause on GET /changes, to every reader of the change', async () => {
    const a = await create('ed', 'h1', 'A', { cause: { note: 'first' } })
    await patch('ed', a, 'A2', { cause: { note: 'second' } })
    const b = await create('ed', 'h1', 'B')

    for (const who of ['ed', 'vw']) {
      const res = await as(who, 'GET', '/changes?after=0')
      expect(res.statusCode, res.body).toBe(200)
      const page = changesPageSchema.parse(res.json())
      expect(page.changes.map((c) => [c.itemId, c.cause])).toEqual([
        [a.id, { note: 'second' }],
        // No cause, no field.
        [b.id, undefined],
      ])
      expect(page.changes[1]).not.toHaveProperty('cause')
    }
  })

  describe('shapes refused at their limits (400)', () => {
    const note500 = 'n'.repeat(500)
    const url2048 = `https://e.example/${'a'.repeat(2048 - 'https://e.example/'.length)}`
    const tenUrls = Array.from({ length: 10 }, (_, i) => `https://e.example/${String(i)}`)

    it.each<[string, ItemCause]>([
      ['a note of 500 characters', { note: note500 }],
      ['10 evidence URLs', { evidence: tenUrls }],
      ['a URL of 2,048 characters', { evidence: [url2048] }],
      ['an upper-case scheme', { evidence: ['HTTPS://e.example/x'] }],
      ['every field', { note: 'n', evidence: [URL_A], causedBy: 1 }],
    ])('accepts %s', async (_, cause) => {
      const a = await create('ed', 'h1', 'A')
      await patch('ed', a, 'A2', { cause })
    })

    it.each<[string, unknown]>([
      ['an empty cause', {}],
      ['an empty note', { note: '' }],
      ['a blank note', { note: '   ' }],
      ['a note of 501 characters', { note: `${note500}n` }],
      ['no evidence in the list', { evidence: [] }],
      ['11 evidence URLs', { evidence: [...tenUrls, URL_A] }],
      ['a URL of 2,049 characters', { evidence: [`${url2048}a`] }],
      ['a relative URL', { evidence: ['/runs/1'] }],
      ['another scheme', { evidence: ['javascript:alert(1)'] }],
      ['a URL that is not text', { evidence: [42] }],
      ['causedBy 0', { causedBy: 0 }],
      ['a fractional causedBy', { causedBy: 1.5 }],
      ['causedBy as text', { causedBy: '1' }],
      ['an unknown field', { note: 'n', why: 'x' }],
      ['a cause that is text', 'because'],
      ['a null cause', null],
    ])('refuses %s', async (_, cause) => {
      const a = await create('ed', 'h1', 'A')
      const before = await revisionCount()
      const responses = [
        await as('ed', 'POST', '/items', { folderId: 'h1', values: {}, cause }),
        await as('ed', 'PATCH', `/items/${a.id}`, { version: 1, values: { t1: 'x' }, cause }),
        await as('ed', 'DELETE', `/items/${a.id}?version=1`, { cause }),
      ]
      for (const res of responses) {
        expect(res.statusCode, res.body).toBe(400)
        expect(errorOf(res.json()).error).toBe('invalid_request')
      }
      expect(await revisionCount()).toBe(before)
    })
  })

  describe('causedBy', () => {
    it('refuses a missing revision and one the writer cannot read alike (422 invalid_cause)', async () => {
      const hidden = await create('ed', 'h2', 'in h2')
      const mine = await create('e1', 'h1', 'mine')
      const before = await revisionCount()

      for (const causedBy of [hidden.seq, 999]) {
        const cause = { causedBy }
        const responses = [
          await as('e1', 'POST', '/items', { folderId: 'h1', values: {}, cause }),
          await as('e1', 'PATCH', `/items/${mine.id}`, { version: 1, values: { t1: 'x' }, cause }),
          await as('e1', 'DELETE', `/items/${mine.id}?version=1`, { cause }),
        ]
        for (const res of responses) {
          expect(res.statusCode, res.body).toBe(422)
          expect(errorOf(res.json())).toEqual({
            error: 'invalid_cause',
            message: 'causedBy names no revision you can read',
          })
        }
      }
      expect(await revisionCount()).toBe(before)
      // The same number is fine for a writer who can read it.
      await patch('ed', mine, 'x', { cause: { causedBy: hidden.seq } })
    })

    it('refuses a revision outside an agent’s hub', async () => {
      const hidden = await create('ed', 'h2', 'in h2')
      const own = await create('ed', 'h1', 'in h1')
      const res = await as('own', 'POST', '/hubs/h1/agent-keys', { name: 'bot', hubRole: 'editor' })
      expect(res.statusCode, res.body).toBe(201)
      const { secret } = createdAgentKeySchema.parse(res.json())
      const asAgent = (causedBy: number) =>
        app.inject({
          method: 'POST',
          url: `/v1/workspaces/${WS}/items`,
          headers: { authorization: `Bearer ${secret}` },
          payload: { folderId: 'h1', values: {}, cause: { causedBy } },
        })
      const refused = await asAgent(hidden.seq)
      expect(refused.statusCode, refused.body).toBe(422)
      expect(errorOf(refused.json()).error).toBe('invalid_cause')
      expect((await asAgent(own.seq)).statusCode).toBe(201)
    })

    it('refuses a revision of a hub the writer has since lost', async () => {
      const a = await create('e1', 'h1', 'A')
      const b = await create('ed', 'h2', 'B')
      expect((await as('own', 'DELETE', '/hubs/h1/grants/e1')).statusCode).toBe(204)
      expect((await as('own', 'PUT', '/hubs/h2/grants/e1', { hubRole: 'editor' })).statusCode).toBe(
        200,
      )
      const res = await as('e1', 'PATCH', `/items/${b.id}`, {
        version: 1,
        values: { t2: 'x' },
        cause: { causedBy: a.seq },
      })
      expect(res.statusCode, res.body).toBe(422)
    })

    it('shows the number to a reader who cannot read that revision, but not what it changed', async () => {
      const hidden = await create('ed', 'h2', 'secret')
      const a = await create('ed', 'h1', 'A')
      await patch('ed', a, 'A2', { cause: { causedBy: hidden.seq } })
      const page = await history('vw', a.id)
      expect(page.items[0]?.cause).toEqual({ causedBy: hidden.seq })
      // vw can read neither the item nor its history.
      expect((await as('vw', 'GET', `/items/${hidden.id}`)).statusCode).toBe(404)
      expect((await as('vw', 'GET', `/items/${hidden.id}/revisions`)).statusCode).toBe(404)
    })
  })

  describe('retries (D59)', () => {
    it('keeps the first attempt’s cause when a retry sends another', async () => {
      const createId = crypto.randomUUID()
      const a = await create('ed', 'h1', 'A', {
        clientMutationId: createId,
        cause: { note: 'first create' },
      })
      const patchId = crypto.randomUUID()
      const a2 = await patch('ed', a, 'A2', {
        clientMutationId: patchId,
        cause: { note: 'first patch' },
      })
      const before = await revisionCount()

      await create('ed', 'h1', 'A', { clientMutationId: createId, cause: { note: 'retry' } })
      await patch('ed', a, 'A2', { clientMutationId: patchId, cause: { note: 'retry' } })
      // A retry is answered before its cause is checked, as the first attempt was.
      await create('ed', 'h1', 'A', { clientMutationId: createId, cause: { causedBy: 999 } })
      await patch('ed', a, 'A2', { clientMutationId: patchId, cause: { causedBy: 999 } })
      expect(await revisionCount()).toBe(before)

      const page = await history('ed', a.id)
      expect(page.items.map((r) => r.cause)).toEqual([
        { note: 'first patch' },
        { note: 'first create' },
      ])

      const deleteId = crypto.randomUUID()
      const url = `/items/${a.id}?version=${String(a2.version)}&clientMutationId=${deleteId}`
      expect((await as('ed', 'DELETE', url, { cause: { note: 'first delete' } })).statusCode).toBe(
        204,
      )
      expect((await as('ed', 'DELETE', url, { cause: { note: 'retry' } })).statusCode).toBe(204)
      expect((await as('ed', 'DELETE', url, { cause: { causedBy: 999 } })).statusCode).toBe(204)
      const deletes = await db
        .selectFrom('revision')
        .select('cause')
        .where('item_id', '=', a.id)
        .where('client_mutation_id', '=', deleteId)
        .execute()
      expect(deletes).toEqual([{ cause: { note: 'first delete' } }])
    })
  })
})

describe('GET /items/:itemId/revisions', () => {
  it('lists an item’s revisions newest first, with every field', async () => {
    const a = await create('ed', 'h1', 'A', { cause: { note: 'made' } })
    const a2 = await patch('ed', a, 'A2')
    const a3 = await patch('own', a2, 'A3', { cause: { evidence: [URL_A] } })
    await create('ed', 'h1', 'other')

    const page = await history('vw', a.id)
    expect(page.nextCursor).toBeNull()
    expect(page.items).toEqual([
      {
        seq: a3.seq,
        version: 3,
        op: 'update',
        patch: { op: 'update', values: { t1: 'A3' } },
        actor: 'own',
        at: expect.any(String) as unknown,
        cause: { evidence: [URL_A] },
      },
      {
        seq: a2.seq,
        version: 2,
        op: 'update',
        patch: { op: 'update', values: { t1: 'A2' } },
        actor: 'ed',
        at: expect.any(String) as unknown,
        cause: null,
      },
      {
        seq: a.seq,
        version: 1,
        op: 'create',
        patch: { op: 'create', folderId: 'h1', values: { t1: 'A' } },
        actor: 'ed',
        at: expect.any(String) as unknown,
        cause: { note: 'made' },
      },
    ])
  })

  it('pages with limit and cursor', async () => {
    let item: Item = await create('ed', 'h1', 'v1')
    for (let v = 2; v <= 5; v++) item = await patch('ed', item, `v${String(v)}`)

    const versions: number[][] = []
    let cursor: string | null = null
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const page = await history('ed', item.id, query)
      versions.push(page.items.map((r) => r.version))
      cursor = page.nextCursor
    } while (cursor)
    expect(versions).toEqual([[5, 4], [3, 2], [1]])
  })

  it('answers 404 exactly where GET of the item does', async () => {
    const hidden = await create('ed', 'h2', 'h2')
    const gone = await create('ed', 'h1', 'gone')
    expect((await as('ed', 'DELETE', `/items/${gone.id}?version=1`)).statusCode).toBe(204)

    for (const [who, id] of [
      ['vw', hidden.id],
      ['ed', gone.id],
      ['ed', 'missing'],
    ] as const) {
      expect((await as(who, 'GET', `/items/${id}`)).statusCode).toBe(404)
      const res = await as(who, 'GET', `/items/${id}/revisions`)
      expect(res.statusCode, res.body).toBe(404)
      expect(errorOf(res.json())).toEqual({ error: 'not_found', message: 'Item not found' })
    }
  })

  it('refuses a bad limit or cursor', async () => {
    const a = await create('ed', 'h1', 'A')
    for (const query of ['?limit=0', '?limit=201', '?cursor=nope', '?cursor=WyJ4Il0', '?x=1']) {
      const res = await as('ed', 'GET', `/items/${a.id}/revisions${query}`)
      expect(res.statusCode, `${query}: ${res.body}`).toBe(400)
    }
    expect((await history('ed', a.id, '?limit=200')).items).toHaveLength(1)
  })

  it('serves an agent its own hub only', async () => {
    const one = await create('ed', 'h1', 'one', { cause: { note: 'n' } })
    const two = await create('ed', 'h2', 'two')
    const key = await as('own', 'POST', '/hubs/h1/agent-keys', { name: 'bot', hubRole: 'viewer' })
    const { secret } = createdAgentKeySchema.parse(key.json())
    const read = (id: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WS}/items/${id}/revisions`,
        headers: { authorization: `Bearer ${secret}` },
      })
    const res = await read(one.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(revisionPageSchema.parse(res.json()).items[0]?.cause).toEqual({ note: 'n' })
    expect((await read(two.id)).statusCode).toBe(404)
  })
})
