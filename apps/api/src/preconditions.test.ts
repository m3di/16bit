import {
  apiErrorSchema,
  createdAgentKeySchema,
  itemWriteResultSchema,
  preconditionFailedErrorSchema,
  revisionPageSchema,
  type HubRole,
} from '@16bit/core'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'
import { KeyRace, rerunOnKeyRace, UPSERT_ATTEMPTS } from './items.ts'

// Write preconditions and server-clock values (D66, #203): `condition` on patch and upsert,
// evaluated after the row lock against the item's current values, 412 `precondition_failed`
// with nothing written, and `{ "$now": ... }` in date values and condition operands, read with
// `clock_timestamp()` after the lock. Against a real Postgres under row-level security.

const WS = 'w1'

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
const cookies = new Map<string, string>()
const PEOPLE = ['own', 'ed', 'vw'] as const

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
 * Hub h1 with folder f1. Attributes on both: `title` (text), `owner` (actor), `lease` (date
 * with time) and `due` (date, indexed). Only `due` is indexed: conditions may name any of them.
 * `own` is hub admin, `ed` an editor, `vw` a viewer.
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
  const folder = (id: string) => ({
    workspace_id: WS,
    id,
    hub_id: 'h1',
    parent_id: id === 'h1' ? null : 'h1',
    name: id,
    color: 'blue',
    id_prefix: 'ONE',
  })
  await db.insertInto('folder').values(folder('h1')).execute()
  await db.insertInto('folder').values(folder('f1')).execute()
  const attributes = [
    { id: 'title', type: 'text' as const, config: {}, indexed: false },
    { id: 'owner', type: 'actor' as const, config: {}, indexed: false },
    { id: 'lease', type: 'date' as const, config: { includeTime: true }, indexed: false },
    { id: 'due', type: 'date' as const, config: {}, indexed: true },
  ]
  await db
    .insertInto('attribute')
    .values(
      attributes.map((a) => ({
        workspace_id: WS,
        id: a.id,
        hub_id: 'h1',
        name: a.id,
        type: a.type,
        config: JSON.stringify(a.config),
        indexed: a.indexed,
      })),
    )
    .execute()
  await db
    .insertInto('folder_attribute')
    .values(
      ['h1', 'f1'].flatMap((folderId) =>
        attributes.map((a, position) => ({
          workspace_id: WS,
          hub_id: 'h1',
          folder_id: folderId,
          attribute_id: a.id,
          position,
        })),
      ),
    )
    .execute()
  const grant = (principal: string, role: HubRole) => ({
    workspace_id: WS,
    hub_id: 'h1',
    principal_id: principal,
    hub_role: role,
  })
  await db
    .insertInto('hub_grant')
    .values([grant('own', 'hub_admin'), grant('ed', 'editor'), grant('vw', 'viewer')])
    .execute()
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

/** A new editor agent key on h1, and its principal ID. */
async function agent(): Promise<{ id: string; call: Caller }> {
  const res = await person('own')('POST', '/hubs/h1/agent-keys', { name: 'bot', hubRole: 'editor' })
  expect(res.statusCode, res.body).toBe(201)
  const { key, secret } = createdAgentKeySchema.parse(res.json())
  return {
    id: key.id,
    call: (method, url, payload) =>
      app.inject({
        method: method as 'GET',
        url: `/v1/workspaces/${WS}${url}`,
        headers: { authorization: `Bearer ${secret}` },
        ...(payload !== undefined && { payload }),
      }),
  }
}

const ed = person('ed')

async function create(values: object, extra: object = {}) {
  const res = await ed('POST', '/items', { folderId: 'h1', values, ...extra })
  expect(res.statusCode, res.body).toBe(201)
  return itemWriteResultSchema.parse(res.json())
}

const errorOf = (body: unknown) => apiErrorSchema.parse(body)

/** The database clock, as the writes read it. */
async function dbNow(): Promise<number> {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)
  return (rows[0]?.now ?? new Date(0)).getTime()
}

/** The claim from D68: take the item if nobody holds it or the lease has run out. */
const claimable = {
  or: [
    { attribute: 'owner', op: 'is_empty' },
    { attribute: 'lease', op: 'lt', value: { $now: 'PT0S' } },
  ],
}
const claim = (who: string, version?: number) => ({
  ...(version !== undefined && { version }),
  values: { owner: [who], lease: { $now: 'PT10M' } },
  condition: claimable,
})

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

const holdItem = (id: string) =>
  holding((trx) => trx.selectFrom('item').select('id').where('id', '=', id).forUpdate().execute())

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

describe('condition on PATCH', () => {
  it('writes when the condition holds, on attributes that are not indexed', async () => {
    const item = await create({ title: 'Fix the Build' })
    const res = await ed('PATCH', `/items/${item.id}`, {
      version: 1,
      values: { title: 'Fixed' },
      condition: {
        and: [
          { attribute: 'title', op: 'contains', value: 'the build' },
          { attribute: 'owner', op: 'is_empty' },
          { attribute: 'title', op: 'neq', value: 'Fixed' },
        ],
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ version: 2, values: { title: 'Fixed' } })
  })

  it('answers 412 with the current item and writes nothing when it fails', async () => {
    const item = await create({ title: 'a', owner: ['ed'] })
    const before = await workspaceSnapshot(db, WS)
    const res = await ed('PATCH', `/items/${item.id}`, {
      version: 1,
      values: { title: 'b' },
      condition: { attribute: 'owner', op: 'is_empty' },
    })
    expect(res.statusCode, res.body).toBe(412)
    const body = preconditionFailedErrorSchema.parse(res.json())
    expect(body.current).toMatchObject({ id: item.id, version: 1, values: { owner: ['ed'] } })
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('checks the version before the condition (409, not 412)', async () => {
    const item = await create({ title: 'a', owner: ['ed'] })
    const res = await ed('PATCH', `/items/${item.id}`, {
      version: 7,
      values: { title: 'b' },
      condition: { attribute: 'owner', op: 'is_empty' },
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(errorOf(res.json()).error).toBe('conflict')
  })

  it('refuses a malformed condition with 400 listing every problem', async () => {
    const item = await create({ title: 'a' })
    const before = await workspaceSnapshot(db, WS)
    const res = await ed('PATCH', `/items/${item.id}`, {
      version: 1,
      values: { title: 'b' },
      condition: {
        and: [
          { attribute: 'nope', op: 'eq', value: 'x' },
          { attribute: 'owner', op: 'eq', value: 'ed' },
          { attribute: 'lease', op: 'gt', value: 'not a date' },
          { attribute: 'lease', op: 'gt', value: { $now: 'P1Y' } },
          { attribute: 'title', op: 'eq', value: { $now: 'PT1H' } },
          { attribute: 'lease', op: 'is_empty', value: { $now: 'PT1H' } },
        ],
      },
    })
    expect(res.statusCode, res.body).toBe(400)
    const body = res.json<{ error: string; errors: { path: string }[] }>()
    expect(body.error).toBe('invalid_request')
    expect(body.errors.map((e) => e.path).sort()).toEqual(
      [
        'condition.and.0',
        'condition.and.1',
        'condition.and.2.value',
        'condition.and.3.value',
        'condition.and.4.value',
        'condition.and.5.value',
      ].sort(),
    )
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('is checked for a viewer only after the role: 403', async () => {
    const item = await create({ title: 'a' })
    const res = await person('vw')('PATCH', `/items/${item.id}`, {
      version: 1,
      values: { title: 'b' },
      condition: { attribute: 'owner', op: 'is_empty' },
    })
    expect(res.statusCode, res.body).toBe(403)
  })

  it('records nothing under a failed clientMutationId, so a retry is evaluated again', async () => {
    const item = await create({ title: 'a', owner: ['ed'] })
    const body = {
      version: 1,
      values: { title: 'mine' },
      condition: { attribute: 'owner', op: 'is_empty' },
      clientMutationId: '5b9d8a3c-4b7e-4f3a-9a52-1c2d3e4f5a6b',
    }
    const failed = await ed('PATCH', `/items/${item.id}`, body)
    expect(failed.statusCode, failed.body).toBe(412)
    const freed = await person('own')('PATCH', `/items/${item.id}`, {
      version: 1,
      values: { owner: null },
    })
    expect(freed.statusCode, freed.body).toBe(200)
    // Same ID, now against version 2: evaluated afresh, and it holds.
    const retry = await ed('PATCH', `/items/${item.id}`, { ...body, version: 2 })
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json()).toMatchObject({ version: 3, values: { title: 'mine' } })
    // And now it is recorded: a further retry replays.
    const replay = await ed('PATCH', `/items/${item.id}`, { ...body, version: 2 })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ version: 3 })
  })
})

describe('condition on the upsert by key', () => {
  const put = (call: Caller, key: string, body: object) =>
    call('PUT', `/hubs/h1/items/by-key/${encodeURIComponent(key)}`, { folderId: 'f1', ...body })

  it('evaluates against an empty item when no item holds the key', async () => {
    const before = await workspaceSnapshot(db, WS)
    for (const condition of [
      { attribute: 'title', op: 'eq', value: 'x' },
      { attribute: 'lease', op: 'lt', value: { $now: 'PT0S' } },
      { attribute: 'owner', op: 'is_not_empty' },
    ]) {
      const res = await put(ed, 'k', { values: { title: 'x' }, condition })
      expect(res.statusCode, res.body).toBe(412)
      expect(preconditionFailedErrorSchema.parse(res.json()).current).toBeNull()
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)

    const made = await put(ed, 'k', {
      values: { title: 'x' },
      condition: {
        and: [
          { attribute: 'owner', op: 'is_empty' },
          { attribute: 'title', op: 'neq', value: 'x' },
          { attribute: 'owner', op: 'not_in', value: ['ed'] },
        ],
      },
    })
    expect(made.statusCode, made.body).toBe(201)
  })

  it('evaluates against the item that holds the key, and checks a no-op too', async () => {
    await put(ed, 'k', { values: { title: 'x', owner: ['ed'] } })
    const failed = await put(ed, 'k', { condition: { attribute: 'owner', op: 'is_empty' } })
    expect(failed.statusCode, failed.body).toBe(412)
    expect(preconditionFailedErrorSchema.parse(failed.json()).current).toMatchObject({
      externalKey: 'k',
      version: 1,
    })
    const held = await put(ed, 'k', { condition: { attribute: 'owner', op: 'in', value: ['ed'] } })
    expect(held.statusCode, held.body).toBe(200)
    expect(held.json()).toMatchObject({ version: 1 })
    const stale = await put(ed, 'k', {
      version: 9,
      condition: { attribute: 'owner', op: 'is_empty' },
    })
    expect(stale.statusCode, stale.body).toBe(409)
  })
})

describe('server-clock values ($now)', () => {
  it('stores the database clock plus the offset, a UTC date on a date-only attribute', async () => {
    const start = await dbNow()
    const item = await create({ lease: { $now: 'PT45M' }, due: { $now: '-P1D' } })
    const end = await dbNow()
    const lease = Date.parse(item.values['lease'] as string)
    expect(lease).toBeGreaterThanOrEqual(start + 45 * 60_000)
    expect(lease).toBeLessThanOrEqual(end + 45 * 60_000)
    expect(item.values['due']).toBe(new Date(start - 86_400_000).toISOString().slice(0, 10))

    // The history and the index hold the resolved date, not `$now`.
    const history = revisionPageSchema.parse(
      (await ed('GET', `/items/${item.id}/revisions`)).json(),
    )
    expect(history.items[0]?.patch).toMatchObject({ values: item.values })
    const query = await ed('POST', '/query', {
      from: 'h1',
      limit: 10,
      where: { attribute: 'due', op: 'eq', value: item.values['due'] },
    })
    expect(query.json<{ items: unknown[] }>().items).toHaveLength(1)
  })

  it('refuses a malformed $now or one on another type with 422, writing nothing', async () => {
    const before = await workspaceSnapshot(db, WS)
    for (const values of [
      { lease: { $now: 'P1Y' } },
      { lease: { $now: '-P367D' } },
      { lease: { $now: 'PT1H', extra: 1 } },
      { title: { $now: 'PT1H' } },
    ]) {
      const res = await ed('POST', '/items', { folderId: 'h1', values })
      expect(res.statusCode, `${JSON.stringify(values)}: ${res.body}`).toBe(422)
      expect(errorOf(res.json()).error).toBe('invalid_values')
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
    // At the 366-day edge it is accepted.
    await create({ lease: { $now: '-P366D' } })
  })

  it('compares dates with $now in a condition, on indexed and unindexed attributes', async () => {
    const expired = await create({ owner: ['ed'], lease: { $now: '-PT1M' }, due: { $now: 'P1D' } })
    const live = await create({ owner: ['ed'], lease: { $now: 'PT1H' }, due: { $now: '-P1D' } })
    const patch = (id: string, condition: object) =>
      ed('PATCH', `/items/${id}`, { version: 1, values: { title: 't' }, condition })

    expect((await patch(live.id, claimable)).statusCode).toBe(412)
    expect(
      (await patch(live.id, { attribute: 'due', op: 'gte', value: { $now: 'PT0S' } })).statusCode,
    ).toBe(412)
    expect(
      (await patch(live.id, { attribute: 'due', op: 'lt', value: { $now: 'PT0S' } })).statusCode,
    ).toBe(200)
    expect(
      (await patch(expired.id, { attribute: 'due', op: 'gt', value: { $now: 'PT0S' } })).statusCode,
    ).toBe(200)
    // Claimed once the lease has run out.
    const taken = await ed('PATCH', `/items/${expired.id}`, claim('vw', 2))
    expect(taken.statusCode, taken.body).toBe(200)
    expect(taken.json()).toMatchObject({ values: { owner: ['vw'] } })
  })

  it('reads the clock after the row lock, not at the start of the transaction', async () => {
    const item = await create({ title: 'a' })
    const release = await holdItem(item.id)
    const pending = ed('PATCH', `/items/${item.id}`, {
      version: 1,
      values: { lease: { $now: 'PT0S' } },
    })
    await waiting(1)
    await new Promise((done) => setTimeout(done, 300))
    const released = await dbNow()
    await release()
    const res = await pending
    expect(res.statusCode, res.body).toBe(200)
    expect(
      Date.parse(res.json<{ values: { lease: string } }>().values.lease),
    ).toBeGreaterThanOrEqual(released)
  })
})

describe('racing claims', () => {
  it('two agents claiming one item: exactly one wins, the other gets 412 naming the winner', async () => {
    const [a, b] = [await agent(), await agent()]
    const item = await create({ title: 'job' }, { externalKey: 'job-1' })
    const release = await holdItem(item.id)
    const url = '/hubs/h1/items/by-key/job-1'
    const racing = [
      a.call('PUT', url, { folderId: 'h1', ...claim(a.id) }),
      b.call('PUT', url, { folderId: 'h1', ...claim(b.id) }),
    ]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 412])
    const winner = answers.findIndex((r) => r.statusCode === 200) === 0 ? a : b
    const lost = answers.find((r) => r.statusCode === 412)
    expect(preconditionFailedErrorSchema.parse(lost?.json()).current).toMatchObject({
      version: 2,
      values: { owner: [winner.id] },
    })
  })

  it('five agents claiming at once, unforced: exactly one wins', async () => {
    const agents = await Promise.all([1, 2, 3, 4, 5].map(() => agent()))
    await create({ title: 'job' }, { externalKey: 'job-2' })
    const answers = await Promise.all(
      agents.map((x) =>
        x.call('PUT', '/hubs/h1/items/by-key/job-2', { folderId: 'h1', ...claim(x.id) }),
      ),
    )
    expect(answers.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(answers.filter((r) => r.statusCode === 412)).toHaveLength(4)
  })

  it('two agents claiming a key nobody holds yet: one creates it, the other gets 412', async () => {
    const [a, b] = [await agent(), await agent()]
    const release = await holding((trx) =>
      trx.selectFrom('folder').select('id').where('id', '=', 'h1').forUpdate().execute(),
    )
    const url = '/hubs/h1/items/by-key/new-job'
    const racing = [
      a.call('PUT', url, { folderId: 'h1', ...claim(a.id) }),
      b.call('PUT', url, { folderId: 'h1', ...claim(b.id) }),
    ]
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(answers.map((r) => r.statusCode).sort()).toEqual([201, 412])
  })

  it('a retry racing its first claim answers as the first did, not 412', async () => {
    const a = await agent()
    const item = await create({ title: 'job' }, { externalKey: 'job-3' })
    const body = {
      folderId: 'h1',
      ...claim(a.id),
      clientMutationId: '6b9d8a3c-4b7e-4f3a-9a52-1c2d3e4f5a6b',
    }
    const release = await holdItem(item.id)
    const racing = [1, 2].map(() => a.call('PUT', '/hubs/h1/items/by-key/job-3', body))
    await waiting(2)
    await release()
    const answers = await Promise.all(racing)
    expect(answers.map((r) => r.statusCode)).toEqual([200, 200])
    const history = revisionPageSchema.parse(
      (await ed('GET', `/items/${item.id}/revisions`)).json(),
    )
    expect(history.items).toHaveLength(2)
  })
})

describe('rerunOnKeyRace', () => {
  it('reruns on KeyRace and gives up after the last run with 409 key_taken', async () => {
    let runs = 0
    const always = () => {
      runs++
      return Promise.reject(new KeyRace())
    }
    await expect(rerunOnKeyRace(always)).rejects.toMatchObject({ code: 'key_taken', status: 409 })
    expect(runs).toBe(UPSERT_ATTEMPTS)

    runs = 0
    const second = () => (++runs < 2 ? Promise.reject(new KeyRace()) : Promise.resolve('ok'))
    await expect(rerunOnKeyRace(second)).resolves.toBe('ok')
    expect(runs).toBe(2)

    const other = new Error('boom')
    runs = 0
    await expect(
      rerunOnKeyRace(() => {
        runs++
        return Promise.reject(other)
      }),
    ).rejects.toBe(other)
    expect(runs).toBe(1)
  })
})
