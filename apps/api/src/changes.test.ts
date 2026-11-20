import {
  apiErrorSchema,
  changesPageSchema,
  hubDescriptionSchema,
  itemQueryResultSchema,
  itemReadSchema,
  itemWriteResultSchema,
  type ChangesPage,
  type HubRole,
  type Item,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { readChanges } from './changes.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { withScope, workspaceSeq } from './db/scope.ts'
import { createTestDatabase } from './db/test-database.ts'
import { itemOf } from './db/test-responses.ts'
import { sessionCookie } from './db/test-session.ts'
import { queryItems } from './items.ts'
import { resetPassword } from './reset-password.ts'

// The change reader and `GET /changes` (D58), the workspace `seq` on reads and writes, and
// idempotent item writes (D59), against a real Postgres under row-level security.

const WS = 'w1'

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let ownerUrl: string
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
  for (const p of ['own', 'ed', 'vw']) cookies.set(p, (await sessionCookie(db, p)).cookie)
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * Hubs h1 and h2, each with a text attribute (t1, t2) shown on the hub. `own` (owner) is hub
 * admin of both, `ed` (member) an editor of both, `vw` (member) a viewer of h1 only.
 */
async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: WS, name: 'W' }).execute()
  await db
    .insertInto('principal')
    .values([
      { workspace_id: WS, id: 'own', kind: 'user', name: 'Own', workspace_role: 'owner' },
      { workspace_id: WS, id: 'ed', kind: 'user', name: 'Ed', workspace_role: 'member' },
      { workspace_id: WS, id: 'vw', kind: 'user', name: 'Vw', workspace_role: 'member' },
    ])
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
        name: 'Title',
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

async function changes(who: string, after: number, limit?: number): Promise<ChangesPage> {
  const query = `after=${String(after)}${limit === undefined ? '' : `&limit=${String(limit)}`}`
  const res = await as(who, 'GET', `/changes?${query}`)
  expect(res.statusCode, res.body).toBe(200)
  return changesPageSchema.parse(res.json())
}

const counter = async () =>
  (
    await db
      .selectFrom('workspace')
      .select('next_revision_seq')
      .where('id', '=', WS)
      .executeTakeFirstOrThrow()
  ).next_revision_seq - 1

const revisionCount = async () =>
  Number(
    (
      await db
        .selectFrom('revision')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  )

const errorOf = (body: unknown) => apiErrorSchema.parse(body).error

describe('GET /changes (D58)', () => {
  it('never shows a viewer changes in a hub they lack, and moves the high-water mark past them', async () => {
    const a = await create('ed', 'h1', 'A')
    await create('ed', 'h2', 'hidden 1')
    await create('ed', 'h2', 'hidden 2')

    const page = await changes('vw', 0)
    expect(page.changes.map((c) => c.itemId)).toEqual([a.id])
    expect(page.changes.every((c) => c.hubId === 'h1')).toBe(true)
    expect(page.seq).toBe(3)
    expect(page.more).toBe(false)

    // Only hidden changes since: nothing to show, but `after` still moves on.
    await create('ed', 'h2', 'hidden 3')
    const next = await changes('vw', page.seq)
    expect(next).toEqual({ changes: [], seq: 4, more: false })
    // The editor sees both hubs.
    expect((await changes('ed', 0)).changes.map((c) => c.hubId)).toEqual(['h1', 'h2', 'h2', 'h2'])
  })

  it('stops changes from a hub once the grant is revoked, past ones included', async () => {
    await create('ed', 'h1', 'before')
    expect((await changes('vw', 0)).changes).toHaveLength(1)
    const revoke = await as('own', 'DELETE', '/hubs/h1/grants/vw')
    expect(revoke.statusCode, revoke.body).toBe(204)
    await create('ed', 'h1', 'after')
    expect(await changes('vw', 0)).toEqual({ changes: [], seq: 2, more: false })
  })

  it('collapses an item to its latest state, and a deleted one to null', async () => {
    const a = await create('ed', 'h1', 'A', { clientMutationId: crypto.randomUUID() })
    const a2 = await patch('ed', a, 'A2')
    const mutation = crypto.randomUUID()
    const a3 = await patch('ed', a2, 'A3', { clientMutationId: mutation })
    const b = await create('ed', 'h1', 'B')
    const page = await changes('vw', 0)
    expect(page.changes).toEqual([
      { seq: a3.seq, hubId: 'h1', itemId: a.id, item: itemOf(a3), clientMutationId: mutation },
      { seq: b.seq, hubId: 'h1', itemId: b.id, item: itemOf(b) },
    ])

    const del = await as('ed', 'DELETE', `/items/${b.id}?version=1`)
    expect(del.statusCode).toBe(204)
    const after = await changes('vw', b.seq)
    expect(after.changes).toEqual([{ seq: 5, hubId: 'h1', itemId: b.id, item: null }])
    // Read from the start, the create and the delete of b collapse to one change: gone.
    expect((await changes('vw', 0)).changes.at(-1)).toMatchObject({ itemId: b.id, item: null })
  })

  it('follows a page cut short by limit with the rows it left out', async () => {
    const items: Item[] = []
    for (const title of ['a', 'b', 'c', 'd', 'e']) items.push(await create('ed', 'h1', title))
    await create('ed', 'h2', 'hidden')

    const first = await changes('vw', 0, 2)
    expect(first.changes.map((c) => c.seq)).toEqual([1, 2])
    expect(first).toMatchObject({ seq: 2, more: true })
    const second = await changes('vw', first.seq, 2)
    expect(second.changes.map((c) => c.seq)).toEqual([3, 4])
    expect(second).toMatchObject({ seq: 4, more: true })
    const third = await changes('vw', second.seq, 2)
    expect(third.changes.map((c) => c.itemId)).toEqual([items[4]?.id])
    expect(third).toMatchObject({ seq: 6, more: false })
  })

  it('bounds the scan, and the high-water mark still moves past hidden changes', async () => {
    for (let i = 0; i < 5; i++) await create('ed', 'h2', `hidden ${String(i)}`)
    await create('ed', 'h1', 'shown')
    const read = (after: number) =>
      withScope(
        appDb,
        { workspaceId: WS, principalId: 'vw' },
        (trx) => readChanges(trx, WS, { after, limit: 100, maxScan: 2 }),
        { snapshot: true },
      )
    expect(await read(0)).toEqual({ changes: [], seq: 2, more: true })
    expect(await read(2)).toEqual({ changes: [], seq: 4, more: true })
    const last = await read(4)
    expect(last.changes.map((c) => c.seq)).toEqual([6])
    expect(last).toMatchObject({ seq: 6, more: false })
  })

  it('reads only the hubs asked for', async () => {
    await create('ed', 'h1', 'one')
    await create('ed', 'h2', 'two')
    const read = (hubIds: string[]) =>
      withScope(appDb, { workspaceId: WS, principalId: 'ed' }, (trx) =>
        readChanges(trx, WS, { after: 0, limit: 10, hubIds }),
      )
    expect((await read(['h2'])).changes.map((c) => c.hubId)).toEqual(['h2'])
    expect(await read([])).toEqual({ changes: [], seq: 2, more: false })
  })

  it('serves an agent its own hub only', async () => {
    await create('ed', 'h1', 'one')
    await create('ed', 'h2', 'two')
    const key = await as('own', 'POST', '/hubs/h2/agent-keys', { name: 'Bot', hubRole: 'viewer' })
    expect(key.statusCode, key.body).toBe(201)
    const { secret } = key.json<{ secret: string }>()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${WS}/changes?after=0`,
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(res.statusCode, res.body).toBe(200)
    const page = changesPageSchema.parse(res.json())
    expect(page.changes.map((c) => c.hubId)).toEqual(['h2'])
    expect(page.seq).toBe(2)
  })

  it('refuses a bad after or limit', async () => {
    for (const query of [
      '',
      'after=',
      'after=-1',
      'after=1.5',
      'after=0&limit=0',
      'after=0&limit=1001',
    ]) {
      const res = await as('vw', 'GET', `/changes?${query}`)
      expect(res.statusCode, query).toBe(400)
    }
    expect((await as('vw', 'GET', '/changes?after=99')).json()).toEqual({
      changes: [],
      seq: 0,
      more: false,
    })
  })
})

describe('the workspace seq on reads and writes (D58)', () => {
  it('carries the seq on item, query and hub reads, and on writes', async () => {
    const a = await create('ed', 'h1', 'A')
    expect(a.seq).toBe(1)
    await create('ed', 'h2', 'hidden')
    const a2 = await patch('ed', a, 'A2')
    expect(a2.seq).toBe(3)

    const item = await as('vw', 'GET', `/items/${a.id}`)
    expect(itemReadSchema.parse(item.json()).seq).toBe(3)
    const query = await as('vw', 'POST', '/query', { from: 'h1', limit: 10 })
    expect(itemQueryResultSchema.parse(query.json()).seq).toBe(3)
    const hub = await as('vw', 'GET', '/hubs/h1')
    expect(hubDescriptionSchema.parse(hub.json()).seq).toBe(3)
  })

  it('does not miss an item changed between a query and GET /changes', async () => {
    const a = await create('ed', 'h1', 'A')
    const read = (snapshot: boolean) =>
      withScope(
        appDb,
        { workspaceId: WS, principalId: 'vw' },
        async (trx) => {
          const page = await queryItems(
            trx,
            WS,
            { id: 'vw', kind: 'user', workspaceRole: 'member' },
            { from: 'h1', where: null, sort: [], limit: 10, cursor: null },
          )
          // A write commits between the rows and the seq.
          const current = itemOf((await as('vw', 'GET', `/items/${a.id}`)).json())
          await patch('ed', current, `changed ${String(current.version)}`)
          return { page, seq: await workspaceSeq(trx, WS) }
        },
        { snapshot },
      )

    // The routes' REPEATABLE READ snapshot: the seq is as old as the rows, so the change after
    // it is in GET /changes.
    const live = await read(true)
    expect(live.page.items[0]?.version).toBe(1)
    expect(live.seq).toBe(1)
    const page = await changes('vw', live.seq)
    expect(page.changes.map((c) => [c.itemId, c.item?.version])).toEqual([[a.id, 2]])

    // At READ COMMITTED the same reads pair version 2's row with version 3's seq: a client
    // subscribing from it would never hear of version 3.
    const stale = await read(false)
    expect(stale.page.items[0]?.version).toBe(2)
    expect(stale.seq).toBe(3)
    expect((await changes('vw', stale.seq)).changes).toEqual([])
  })

  it('reads in a read-only transaction', async () => {
    await expect(
      withScope(
        appDb,
        { workspaceId: WS, principalId: 'ed' },
        (trx) => sql`UPDATE workspace SET next_revision_seq = next_revision_seq + 1`.execute(trx),
        { snapshot: true },
      ),
    ).rejects.toMatchObject({ code: '25006' })
  })
})

describe('client mutation IDs (D59)', () => {
  it('answers a retried create, patch and delete as the first attempt did, writing nothing', async () => {
    const createId = crypto.randomUUID()
    const a = await create('ed', 'h1', 'A', { clientMutationId: createId })
    const patchId = crypto.randomUUID()
    const a2 = await patch('ed', a, 'A2', { clientMutationId: patchId })
    const before = { revisions: await revisionCount(), seq: await counter() }

    // The create's retry: 201, with the item as it is now.
    const created = await create('ed', 'h1', 'A', { clientMutationId: createId })
    expect(itemOf(created)).toEqual(itemOf(a2))
    expect(created.seq).toBe(before.seq)
    // The patch's retry, with the version it was first sent with.
    const patched = await patch('ed', a, 'A2', { clientMutationId: patchId })
    expect(itemOf(patched)).toEqual(itemOf(a2))
    expect({ revisions: await revisionCount(), seq: await counter() }).toEqual(before)

    const deleteId = crypto.randomUUID()
    const url = `/items/${a.id}?version=2&clientMutationId=${deleteId}`
    expect((await as('ed', 'DELETE', url)).statusCode).toBe(204)
    const deleted = { revisions: await revisionCount(), seq: await counter() }
    expect((await as('ed', 'DELETE', url)).statusCode).toBe(204)
    expect({ revisions: await revisionCount(), seq: await counter() }).toEqual(deleted)

    // A create or patch whose item has been deleted since answers as a GET would.
    const recreate = await as('ed', 'POST', '/items', {
      folderId: 'h1',
      values: { t1: 'A' },
      clientMutationId: createId,
    })
    expect(recreate.statusCode).toBe(404)
    const repatch = await as('ed', 'PATCH', `/items/${a.id}`, {
      version: 1,
      values: { t1: 'A2' },
      clientMutationId: patchId,
    })
    expect(repatch.statusCode).toBe(404)
    expect({ revisions: await revisionCount(), seq: await counter() }).toEqual(deleted)
  })

  it('stores the ID on the revision', async () => {
    const id = crypto.randomUUID()
    const a = await create('ed', 'h1', 'A', { clientMutationId: id })
    const row = await db
      .selectFrom('revision')
      .select(['item_id', 'actor', 'client_mutation_id'])
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ item_id: a.id, actor: 'ed', client_mutation_id: id })
  })

  it('refuses the same ID for another item or operation with 422', async () => {
    const id = crypto.randomUUID()
    const a = await create('ed', 'h1', 'A', { clientMutationId: id })
    const b = await create('ed', 'h1', 'B')
    const before = await revisionCount()

    const attempts = [
      as('ed', 'PATCH', `/items/${a.id}`, {
        version: 1,
        values: { t1: 'x' },
        clientMutationId: id,
      }),
      as('ed', 'DELETE', `/items/${a.id}?version=1&clientMutationId=${id}`),
      as('ed', 'POST', '/items', { folderId: 'h2', values: {}, clientMutationId: id }),
      as('ed', 'POST', '/items', { id: 'other', folderId: 'h1', values: {}, clientMutationId: id }),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, res.body).toBe(422)
      expect(errorOf(res.json())).toBe('mutation_id_reused')
    }
    const patchId = crypto.randomUUID()
    await patch('ed', b, 'B2', { clientMutationId: patchId })
    const wrongItem = await as('ed', 'PATCH', `/items/${a.id}`, {
      version: 1,
      values: { t1: 'x' },
      clientMutationId: patchId,
    })
    expect(wrongItem.statusCode).toBe(422)
    expect(await revisionCount()).toBe(before + 1)
    expect(itemOf((await as('ed', 'GET', `/items/${a.id}`)).json()).version).toBe(1)
  })

  it('keeps IDs apart per actor', async () => {
    const id = crypto.randomUUID()
    await create('ed', 'h1', 'mine', { clientMutationId: id })
    const theirs = await create('own', 'h1', 'theirs', { clientMutationId: id })
    expect(theirs.values).toEqual({ t1: 'theirs' })
    expect(await revisionCount()).toBe(2)
  })

  it('answers 404 when the first attempt is in a hub the caller can no longer read', async () => {
    const id = crypto.randomUUID()
    await create('ed', 'h1', 'A', { clientMutationId: id })
    expect((await as('own', 'DELETE', '/hubs/h1/grants/ed')).statusCode).toBe(204)
    const before = await revisionCount()
    // The revision is hidden by row-level security, so this looks like a new create, until the
    // unique index refuses its revision.
    const res = await as('ed', 'POST', '/items', {
      folderId: 'h2',
      values: { t2: 'B' },
      clientMutationId: id,
    })
    expect(res.statusCode, res.body).toBe(404)
    expect(await revisionCount()).toBe(before)
    expect(await db.selectFrom('item').select('id').where('hub_id', '=', 'h2').execute()).toEqual(
      [],
    )
  })

  describe('racing retries', () => {
    /** Holds `lock` in an owner transaction until both requests wait on a lock, then lets go. */
    async function race<T>(lock: string, requests: () => PromiseLike<T>[]): Promise<T[]> {
      const holder = new pg.Client({ connectionString: ownerUrl })
      await holder.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(lock)
        // `inject` starts a request only once it is awaited.
        const pending = requests().map((r) => Promise.resolve(r))
        for (let i = 0; ; i++) {
          // Activity is read once per transaction unless the snapshot is cleared.
          await holder.query('SELECT pg_stat_clear_snapshot()')
          const { rows } = await holder.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
          if (Number(rows[0]?.n) >= pending.length) break
          if (i > 200) throw new Error('the requests never waited on the lock')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await holder.query('COMMIT')
        return await Promise.all(pending)
      } finally {
        await holder.end()
      }
    }

    it('applies a create once when two retries race, and answers both alike', async () => {
      const id = crypto.randomUUID()
      const body = { folderId: 'h1', values: { t1: 'A' }, clientMutationId: id }
      // The hub row: both creates pass the ID check, then wait for the item number.
      const results = await race(`SELECT 1 FROM folder WHERE id = 'h1' FOR UPDATE`, () => [
        as('ed', 'POST', '/items', body),
        as('ed', 'POST', '/items', body),
      ])
      expect(results.map((r) => r.statusCode)).toEqual([201, 201])
      const [first, second] = results.map((r) => itemOf(r.json()))
      expect(second).toEqual(first)
      expect(await revisionCount()).toBe(1)
      expect(await db.selectFrom('item').select('id').execute()).toEqual([{ id: first?.id }])
      expect(
        (await db.selectFrom('folder').select('next_seq').where('id', '=', 'h1').execute())[0],
      ).toEqual({ next_seq: 2 })
    })

    it('applies a patch once when two retries race', async () => {
      const a = await create('ed', 'h1', 'A')
      const body = { version: 1, values: { t1: 'B' }, clientMutationId: crypto.randomUUID() }
      // The item row: both patches pass the ID check, then wait to lock the item.
      const results = await race(`SELECT 1 FROM item WHERE id = '${a.id}' FOR UPDATE`, () => [
        as('ed', 'PATCH', `/items/${a.id}`, body),
        as('ed', 'PATCH', `/items/${a.id}`, body),
      ])
      expect(results.map((r) => r.statusCode)).toEqual([200, 200])
      expect(results.map((r) => itemOf(r.json()).version)).toEqual([2, 2])
      expect(await revisionCount()).toBe(2)
    })

    it('deletes once when two retries race', async () => {
      const a = await create('ed', 'h1', 'A')
      const url = `/items/${a.id}?version=1&clientMutationId=${crypto.randomUUID()}`
      const results = await race(`SELECT 1 FROM item WHERE id = '${a.id}' FOR UPDATE`, () => [
        as('ed', 'DELETE', url),
        as('ed', 'DELETE', url),
      ])
      expect(results.map((r) => r.statusCode)).toEqual([204, 204])
      expect(await revisionCount()).toBe(2)
    })
  })
})

describe('notifications for the feed (D58)', () => {
  let listener: pg.Client
  let heard: { channel: string; payload: unknown }[]

  beforeEach(async () => {
    heard = []
    listener = new pg.Client({ connectionString: ownerUrl })
    await listener.connect()
    listener.on('notification', (n) => {
      const raw = n.payload ?? ''
      heard.push({ channel: n.channel, payload: raw.startsWith('{') ? JSON.parse(raw) : raw })
    })
    for (const channel of ['revision', 'hub', 'access', 'session']) {
      await listener.query(`LISTEN ${channel}`)
    }
  })

  afterEach(async () => {
    await listener.end()
  })

  /** Waits until `count` notifications have arrived, and returns them. */
  async function next(count = 1) {
    for (let i = 0; heard.length < count && i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return heard.splice(0)
  }

  it('notifies schema writes per hub', async () => {
    const hub = hubDescriptionSchema.parse((await as('own', 'GET', '/hubs/h1')).json()).hub
    const res = await as('own', 'PATCH', '/hubs/h1', { version: hub.version, name: 'One' })
    expect(res.statusCode, res.body).toBe(200)
    expect(await next()).toEqual([{ channel: 'hub', payload: { workspaceId: WS, hubId: 'h1' } }])

    const folder = await as('own', 'POST', '/hubs/h2/folders', {
      name: 'Sub',
      parentId: 'h2',
      color: 'blue',
    })
    expect(folder.statusCode, folder.body).toBe(201)
    expect(await next()).toEqual([{ channel: 'hub', payload: { workspaceId: WS, hubId: 'h2' } }])

    // A refused write sends nothing.
    const refused = await as('ed', 'PATCH', '/hubs/h1', { version: 0, name: 'No' })
    expect(refused.statusCode).toBe(403)
    expect(await next(0)).toEqual([])
  })

  it('notifies access changes, member removal and key revocation', async () => {
    expect((await as('own', 'DELETE', '/hubs/h1/grants/vw')).statusCode).toBe(204)
    expect(await next()).toEqual([
      {
        channel: 'access',
        payload: { workspaceId: WS, seq: 1, action: 'grant.revoke', target: 'vw', hubId: 'h1' },
      },
    ])

    expect((await as('own', 'DELETE', '/members/ed')).statusCode).toBe(204)
    expect(await next()).toEqual([
      {
        channel: 'access',
        payload: { workspaceId: WS, seq: 2, action: 'member.remove', target: 'ed', hubId: null },
      },
    ])

    const key = await as('own', 'POST', '/hubs/h1/agent-keys', { name: 'Bot', hubRole: 'viewer' })
    const keyId = key.json<{ key: { id: string } }>().key.id
    await next()
    expect((await as('own', 'POST', `/agent-keys/${keyId}/revoke`)).statusCode).toBe(200)
    expect(await next()).toEqual([
      {
        channel: 'access',
        payload: { workspaceId: WS, seq: 4, action: 'key.revoke', target: keyId, hubId: 'h1' },
      },
    ])
  })

  it('notifies sign-out and a password reset', async () => {
    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: cookies.get('vw') ?? '' },
    })
    expect(out.statusCode).toBe(204)
    const [signedOut] = await next()
    expect(signedOut?.channel).toBe('session')
    const payload = signedOut?.payload as Record<string, string>
    expect(Object.keys(payload)).toEqual(['sessionIdHash'])
    expect(payload['sessionIdHash']).toMatch(/^[0-9a-f]{64}$/)

    expect(await resetPassword(db, 'ed@test.invalid', 'a new long password')).toBe(true)
    expect(await next()).toEqual([{ channel: 'session', payload: { accountId: 'acct-ed' } }])
  })

  it('notifies each item revision with its seq', async () => {
    await create('ed', 'h1', 'A')
    expect(await next()).toEqual([{ channel: 'revision', payload: `${WS}:1` }])
  })
})

describe('errors', () => {
  it('keeps a 409 for a stale version without a known mutation ID', async () => {
    const a = await create('ed', 'h1', 'A')
    await patch('ed', a, 'A2')
    const res = await as('ed', 'PATCH', `/items/${a.id}`, {
      version: 1,
      values: { t1: 'x' },
      clientMutationId: crypto.randomUUID(),
    })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res.json())).toBe('conflict')
  })

  it('refuses a clientMutationId that is not a UUID', async () => {
    const res = await as('ed', 'POST', '/items', {
      folderId: 'h1',
      values: {},
      clientMutationId: 'retry-1',
    })
    expect(res.statusCode).toBe(400)
  })
})
