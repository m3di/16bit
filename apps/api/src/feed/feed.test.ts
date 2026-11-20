import {
  createdAgentKeySchema,
  FEED_CLOSE_CODES,
  MAX_PENDING_CLIENT_MESSAGES,
  feedServerMessageSchema,
  itemWriteResultSchema,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  type FeedServerMessage,
  type HubRole,
} from '@16bit/core'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../app.ts'
import { createSession, DEFAULT_SESSION_POLICY, SESSION_COOKIE } from '../auth/session.ts'
import { createDb, migrateToLatest, type Database } from '../db/database.ts'
import { createTestDatabase } from '../db/test-database.ts'
import { sessionCookie } from '../db/test-session.ts'
import { DEV_OWNER } from '../dev-accounts.ts'
import { applyLargeSeed, LARGE_HUB, LARGE_WORKSPACE } from '../large-seed.ts'
import { resetPassword } from '../reset-password.ts'
import { MAX_SOCKETS_PER_SESSION } from './feed.ts'
import { LISTENER_APPLICATION_NAME } from './listener.ts'

// The WebSocket feed (D57, D58) over a real socket, against a real Postgres under row-level
// security: checks before the upgrade, subscriptions and catch-up, events per role, `resync`,
// `hub` and `access_lost`, sockets closed when credentials end, and a dropped LISTEN connection.

const WS = 'w1'
const RECHECK_MS = 400
const MAX_MISSED = 5

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let port: number
const cookies = new Map<string, string>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  for (const p of ['own', 'ed', 'vw', 'out']) cookies.set(p, (await sessionCookie(db, p)).cookie)
  app = buildApp({
    db: appDb,
    secureCookies: false,
    feed: {
      listenUrl: test.appUrl,
      recheckMs: RECHECK_MS,
      maxMissedChanges: MAX_MISSED,
      listenRetryMs: 50,
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as { port: number }).port
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * Hubs h1, h2 (each with a text attribute t1, t2) and an empty h3. `own` (owner) is hub admin
 * of all three, `ed` (member) an editor of h1 and h2, `vw` (member) a viewer of h1 only. `out`
 * is a member of w2 only.
 */
async function seed(): Promise<void> {
  await db
    .insertInto('workspace')
    .values([
      { id: WS, name: 'W' },
      { id: 'w2', name: 'W2' },
    ])
    .execute()
  await db
    .insertInto('principal')
    .values([
      { workspace_id: WS, id: 'own', kind: 'user', name: 'Own', workspace_role: 'owner' },
      { workspace_id: WS, id: 'ed', kind: 'user', name: 'Ed', workspace_role: 'member' },
      { workspace_id: WS, id: 'vw', kind: 'user', name: 'Vw', workspace_role: 'member' },
      { workspace_id: 'w2', id: 'out', kind: 'user', name: 'Out', workspace_role: 'owner' },
    ])
    .execute()
  for (const [hub, prefix, attribute] of [
    ['h1', 'ONE', 't1'],
    ['h2', 'TWO', 't2'],
    ['h3', 'THR', null],
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
    if (!attribute) continue
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
  await grant([
    ['h1', 'own', 'hub_admin'],
    ['h2', 'own', 'hub_admin'],
    ['h3', 'own', 'hub_admin'],
    ['h1', 'ed', 'editor'],
    ['h2', 'ed', 'editor'],
    ['h1', 'vw', 'viewer'],
  ])
}

async function grant(rows: [string, string, HubRole][]): Promise<void> {
  await db
    .insertInto('hub_grant')
    .values(
      rows.map(([hub, principal, role]) => ({
        workspace_id: WS,
        hub_id: hub,
        principal_id: principal,
        hub_role: role,
      })),
    )
    .execute()
}

const origin = () => `http://127.0.0.1:${String(port)}`
const feedUrl = (workspace = WS) => `ws://127.0.0.1:${String(port)}/v1/workspaces/${workspace}/feed`

const as = (who: string, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url: `/v1/workspaces/${WS}${url}`,
    headers: { cookie: cookies.get(who) ?? '' },
    ...(payload !== undefined && { payload }),
  })

async function create(who: string, hub: 'h1' | 'h2', title: string, extra: object = {}) {
  const res = await as(who, 'POST', '/items', {
    folderId: hub,
    values: { [hub === 'h1' ? 't1' : 't2']: title },
    ...extra,
  })
  expect(res.statusCode, res.body).toBe(201)
  return itemWriteResultSchema.parse(res.json())
}

const counter = async (workspace = WS) =>
  (
    await db
      .selectFrom('workspace')
      .select('next_revision_seq')
      .where('id', '=', workspace)
      .executeTakeFirstOrThrow()
  ).next_revision_seq - 1

/** A feed socket with its messages in a queue, read with `next`. */
interface Client {
  socket: WebSocket
  /** The next message, parsed with the core schema; fails after `ms`. */
  next(ms?: number): Promise<FeedServerMessage>
  /** Resolves with no message for `ms`, or fails with the one that came. */
  quiet(ms?: number): Promise<void>
  send(message: unknown): void
  subscribe(hubId: string, after: number): void
  /** The close code, once closed. */
  closed: Promise<number>
}

function connect(
  headers: Record<string, string>,
  workspace = WS,
  options: { autoPong?: boolean } = {},
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(feedUrl(workspace), { headers, ...options })
    const queue: FeedServerMessage[] = []
    const waiters: ((m: FeedServerMessage) => void)[] = []
    socket.on('message', (data) => {
      const message = feedServerMessageSchema.parse(JSON.parse((data as Buffer).toString('utf8')))
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    })
    const closed = new Promise<number>((done) => {
      socket.on('close', (code) => {
        done(code)
      })
    })
    socket.on('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${String(res.statusCode)}`))
    })
    socket.on('error', reject)
    socket.on('open', () => {
      const next = (ms = 3000) =>
        new Promise<FeedServerMessage>((done, fail) => {
          const queued = queue.shift()
          if (queued) {
            done(queued)
            return
          }
          const timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(take), 1)
            fail(new Error(`no message within ${String(ms)} ms`))
          }, ms)
          const take = (m: FeedServerMessage) => {
            clearTimeout(timer)
            done(m)
          }
          waiters.push(take)
        })
      resolve({
        socket,
        next,
        quiet: async (ms = 300) => {
          const message = await next(ms).catch(() => null)
          if (message) throw new Error(`unexpected message ${JSON.stringify(message)}`)
        },
        send: (m) => {
          socket.send(typeof m === 'string' ? m : JSON.stringify(m))
        },
        subscribe: (hubId, after) => {
          socket.send(JSON.stringify({ type: 'subscribe', hubId, after }))
        },
        closed,
      })
    })
  })
}

const person = (who: string, workspace = WS, options: { autoPong?: boolean } = {}) =>
  connect({ cookie: cookies.get(who) ?? '', origin: origin() }, workspace, options)
const agent = (secret: string) => connect({ authorization: `Bearer ${secret}` })

/** The HTTP status an upgrade is refused with. */
async function refused(headers: Record<string, string>, workspace = WS): Promise<number> {
  const error = await connect(headers, workspace).then(
    (c) => {
      c.socket.close()
      return new Error('upgraded')
    },
    (e: unknown) => e as Error,
  )
  const status = /^HTTP (\d+)$/.exec(error.message)?.[1]
  if (!status) throw error
  return Number(status)
}

async function createKey(hub: string, hubRole: 'viewer' | 'editor' = 'viewer') {
  const res = await as('own', 'POST', `/hubs/${hub}/agent-keys`, { name: 'bot', hubRole })
  expect(res.statusCode, res.body).toBe(201)
  return createdAgentKeySchema.parse(res.json())
}

/** Waits for the next `changes` message, skipping none. */
async function changes(client: Client, ms?: number) {
  const message = await client.next(ms)
  if (message.type !== 'changes')
    throw new Error(`expected changes, got ${JSON.stringify(message)}`)
  return message
}

/** Closes within `ms` with `code`. */
async function closesWithin(
  client: Client,
  ms: number,
  code: number = FEED_CLOSE_CODES.credentialsEnded,
) {
  const started = Date.now()
  const result = await Promise.race([
    client.closed,
    new Promise<null>((done) => {
      setTimeout(() => {
        done(null)
      }, ms)
    }),
  ])
  expect(result, `closed within ${String(ms)} ms`).toBe(code)
  return Date.now() - started
}

describe('before the upgrade (D57)', () => {
  it('refuses without credentials, with cookie and bearer together, and outside the workspace', async () => {
    expect(await refused({ origin: origin() })).toBe(401)
    const key = await createKey('h1')
    expect(
      await refused({
        cookie: cookies.get('ed') ?? '',
        authorization: `Bearer ${key.secret}`,
        origin: origin(),
      }),
    ).toBe(400)
    // A workspace the caller is not in looks like one that does not exist.
    expect(await refused({ cookie: cookies.get('out') ?? '', origin: origin() })).toBe(404)
    expect(await refused({ cookie: cookies.get('ed') ?? '', origin: origin() }, 'nope')).toBe(404)
  })

  it('refuses a cookie upgrade from another origin or with none, and lets an agent in without one', async () => {
    const cookie = cookies.get('ed') ?? ''
    expect(await refused({ cookie, origin: 'https://evil.example' })).toBe(403)
    expect(await refused({ cookie, origin: `http://localhost:${String(port)}` })).toBe(403)
    expect(await refused({ cookie })).toBe(403)
    expect(await refused({ cookie, origin: 'not a url' })).toBe(403)
    const same = await person('ed')
    same.socket.close()
    const key = await createKey('h1')
    const bot = await agent(key.secret)
    bot.socket.close()
  })

  it('answers a plain GET with 426, after the same checks', async () => {
    const key = await createKey('h1')
    const url = `/v1/workspaces/${WS}/feed`
    const plain = await app.inject({ url, headers: { authorization: `Bearer ${key.secret}` } })
    expect(plain.statusCode).toBe(426)
    expect((await app.inject({ url })).statusCode).toBe(401)
  })

  it(`caps a session at ${String(MAX_SOCKETS_PER_SESSION)} sockets`, async () => {
    const open: Client[] = []
    for (let i = 0; i < MAX_SOCKETS_PER_SESSION; i++) open.push(await person('vw'))
    expect(await refused({ cookie: cookies.get('vw') ?? '', origin: origin() })).toBe(429)
    // Another session of another person is not affected, and a closed socket frees a place.
    ;(await person('ed')).socket.close()
    open[0]?.socket.close()
    await open[0]?.closed
    // The server forgets the socket when its own close completes, a moment after the client's.
    const deadline = Date.now() + 2000
    for (;;) {
      const next = await person('vw').catch((e: unknown) => {
        if (Date.now() > deadline) throw e
        return null
      })
      if (next) {
        open.push(next)
        break
      }
    }
    for (const c of open) c.socket.close()
  })
})

describe('subscriptions (D57, D58)', () => {
  it('sends two sockets in different roles only what each may read', async () => {
    const before = await create('ed', 'h1', 'before')
    await create('ed', 'h2', 'hidden from vw')
    const ed = await person('ed')
    const vw = await person('vw')

    // A subscribe is answered by that hub's catch-up, and the message names it.
    vw.subscribe('h1', 0)
    const vwCatchUp = await changes(vw)
    expect(vwCatchUp.hubIds).toEqual(['h1'])
    expect(vwCatchUp.changes.map((c) => c.itemId)).toEqual([before.id])
    expect(vwCatchUp.seq).toBe(2)

    ed.subscribe('h1', 2)
    expect(await changes(ed)).toEqual({ type: 'changes', seq: 2, hubIds: ['h1'], changes: [] })
    ed.subscribe('h2', 0)
    const edH2 = await changes(ed)
    expect(edH2.hubIds).toEqual(['h2'])
    expect(edH2.changes.map((c) => c.hubId)).toEqual(['h2'])

    const mutation = randomUUID()
    const one = await create('ed', 'h1', 'one', { clientMutationId: mutation })
    const edLive = await changes(ed)
    expect(edLive.hubIds.sort()).toEqual(['h1', 'h2'])
    expect(edLive.seq).toBe(one.seq)
    expect(edLive.changes).toEqual([
      {
        seq: one.seq,
        hubId: 'h1',
        itemId: one.id,
        item: expect.objectContaining({ id: one.id }) as unknown,
        clientMutationId: mutation,
      },
    ])
    const vwLive = await changes(vw)
    expect(vwLive.hubIds).toEqual(['h1'])
    // The writer's mutation ID is echoed only to the writer (#170).
    expect(vwLive.changes).toEqual([
      {
        seq: one.seq,
        hubId: 'h1',
        itemId: one.id,
        item: expect.objectContaining({ id: one.id }) as unknown,
      },
    ])

    // A change in h2: ed sees it; vw's high-water mark moves on without it.
    const two = await create('ed', 'h2', 'two')
    expect((await changes(ed)).changes.map((c) => c.itemId)).toEqual([two.id])
    expect(await changes(vw)).toEqual({
      type: 'changes',
      seq: two.seq,
      hubIds: ['h1'],
      changes: [],
    })

    // A delete arrives as the item gone.
    const del = await as('ed', 'DELETE', `/items/${one.id}?version=${String(one.version)}`)
    expect(del.statusCode, del.body).toBe(204)
    const gone = await changes(vw)
    expect(gone.changes).toEqual([
      expect.objectContaining({ hubId: 'h1', itemId: one.id, item: null }),
    ])
    ed.socket.close()
    vw.socket.close()
  })

  it('answers a hidden hub, a missing one and another agent hub alike', async () => {
    const vw = await person('vw')
    vw.subscribe('h2', 0)
    const hidden = await vw.next()
    vw.subscribe('nope', 0)
    const missing = await vw.next()
    expect(hidden).toEqual({
      type: 'error',
      code: 'not_found',
      message: 'Hub not found',
      hubId: 'h2',
    })
    expect(missing).toEqual({ ...hidden, hubId: 'nope' })

    const key = await createKey('h1')
    const bot = await agent(key.secret)
    bot.subscribe('h2', 0)
    expect(await bot.next()).toEqual(hidden)
    bot.subscribe('h1', 0)
    expect((await changes(bot)).hubIds).toEqual(['h1'])
    const item = await create('ed', 'h1', 'for the bot')
    expect((await changes(bot)).changes.map((c) => c.itemId)).toEqual([item.id])
    vw.socket.close()
    bot.socket.close()
  })

  it('restarts a hub on a second subscribe and stops it on unsubscribe', async () => {
    const a = await create('ed', 'h1', 'a')
    const ed = await person('ed')
    ed.subscribe('h1', a.seq)
    expect((await changes(ed)).changes).toEqual([])
    ed.subscribe('h1', 0)
    const again = await changes(ed)
    expect(again.hubIds).toEqual(['h1'])
    expect(again.changes.map((c) => c.itemId)).toEqual([a.id])

    ed.send({ type: 'unsubscribe', hubId: 'h1' })
    ed.send({ type: 'unsubscribe', hubId: 'never-subscribed' })
    await create('ed', 'h1', 'unheard')
    await ed.quiet()
    ed.socket.close()
  })

  it('refuses bad, oversized and excess messages without closing', async () => {
    const extra = Array.from({ length: MAX_SUBSCRIPTIONS_PER_SOCKET }, (_, i) => `x${String(i)}`)
    for (const id of extra) {
      await db
        .insertInto('folder')
        .values({
          workspace_id: WS,
          id,
          hub_id: id,
          parent_id: null,
          name: id,
          color: 'blue',
          id_prefix: id.toUpperCase(),
        })
        .execute()
    }
    await grant(extra.map((id) => [id, 'ed', 'viewer'] as [string, string, HubRole]))
    const ed = await person('ed')

    ed.send('not json')
    expect(await ed.next()).toMatchObject({ type: 'error', code: 'invalid_message' })
    ed.send({ type: 'subscribe', hubId: 'h1' })
    expect(await ed.next()).toMatchObject({ type: 'error', code: 'invalid_message' })
    ed.send({ type: 'unsubscribe', hubId: 'h1', pad: 'x'.repeat(5000) })
    expect(await ed.next()).toMatchObject({ type: 'error', code: 'message_too_large' })

    for (const id of extra) {
      ed.subscribe(id, 0)
      expect((await changes(ed)).hubIds).toEqual([id])
    }
    ed.subscribe('h1', 0)
    expect(await ed.next()).toMatchObject({
      type: 'error',
      code: 'too_many_subscriptions',
      hubId: 'h1',
    })
    // A restart of a hub already held is not a new subscription.
    ed.subscribe('x0', 0)
    expect((await changes(ed)).hubIds).toEqual(['x0'])
    expect(ed.socket.readyState).toBe(WebSocket.OPEN)
    ed.socket.close()
  })
})

describe('resync (D58)', () => {
  it('answers resync past the missed-changes cap, counting only what the subscriber may see', async () => {
    for (let i = 0; i <= MAX_MISSED; i++) await create('ed', 'h1', `h1 ${String(i)}`)
    const ed = await person('ed')
    ed.subscribe('h1', 0)
    expect(await ed.next()).toEqual({ type: 'resync', hubId: 'h1' })
    // The subscription has ended: nothing more for h1 until a new subscribe.
    await create('ed', 'h1', 'after the resync')
    await ed.quiet()

    // vw can read h1 only. Past the cap in h2 is not past it for vw.
    const from = await counter()
    for (let i = 0; i < MAX_MISSED * 2; i++) await create('ed', 'h2', `h2 ${String(i)}`)
    const vw = await person('vw')
    vw.subscribe('h1', from)
    expect(await changes(vw)).toEqual({
      type: 'changes',
      seq: await counter(),
      hubIds: ['h1'],
      changes: [],
    })
    ed.socket.close()
    vw.socket.close()
  })

  it('reads every revision behind one NOTIFY per chunk, as `pnpm seed:large` sends, and resyncs past the cap', async () => {
    await applyLargeSeed(db, { items: 0 })
    const owner = await db
      .selectFrom('principal')
      .select('account_id')
      .where('workspace_id', '=', LARGE_WORKSPACE.id)
      .where('id', '=', DEV_OWNER.id)
      .executeTakeFirstOrThrow()
    const token = await createSession(db, owner.account_id ?? '', DEFAULT_SESSION_POLICY)
    const client = await connect(
      { cookie: `${SESSION_COOKIE}=${token}`, origin: origin() },
      LARGE_WORKSPACE.id,
    )
    client.subscribe(LARGE_HUB.id, await counter(LARGE_WORKSPACE.id))
    expect((await changes(client)).changes).toEqual([])

    // Two chunks of 2: one notification each, naming only the chunk's last `seq`.
    await applyLargeSeed(db, { items: 4, chunk: 2 })
    const seen = new Set<string>()
    let seq = 0
    while (seq < (await counter(LARGE_WORKSPACE.id))) {
      const message = await changes(client)
      expect(message.hubIds).toEqual([LARGE_HUB.id])
      for (const c of message.changes) seen.add(c.itemId)
      seq = message.seq
    }
    expect(seen.size).toBe(4)

    // One chunk past the cap: the live subscription resyncs.
    await applyLargeSeed(db, { items: 4 + MAX_MISSED + 1, chunk: MAX_MISSED + 1 })
    expect(await client.next()).toEqual({ type: 'resync', hubId: LARGE_HUB.id })
    client.socket.close()
  })
})

describe('hub and access events (D58)', () => {
  it('sends hub to each subscriber who can read the hub, and access_lost to one who no longer can', async () => {
    const ed = await person('ed')
    const vw = await person('vw')
    for (const c of [ed, vw]) {
      c.subscribe('h1', await counter())
      await changes(c)
    }
    const hub = await as('own', 'GET', '/hubs/h1')
    const version = hub.json<{ hub: { version: number } }>().hub.version
    const renamed = await as('own', 'PATCH', '/hubs/h1', { version, name: 'Renamed' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    for (const c of [ed, vw]) {
      expect(await c.next()).toEqual({ type: 'hub', hubId: 'h1', version: version + 1 })
    }

    const revoke = await as('own', 'DELETE', '/hubs/h1/grants/vw')
    expect(revoke.statusCode, revoke.body).toBe(204)
    expect(await vw.next()).toEqual({ type: 'access_lost', hubId: 'h1' })
    await ed.quiet()
    // The subscription ended: vw hears nothing more of h1.
    await create('ed', 'h1', 'after the revoke')
    expect((await changes(ed)).changes).toHaveLength(1)
    await vw.quiet()
    ed.socket.close()
    vw.socket.close()
  })
})

describe('closing sockets when credentials end (D58)', () => {
  it('closes the socket within a second on sign-out, not the other session', async () => {
    const vw = await person('vw')
    const other = await person('ed')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: cookies.get('vw') ?? '',
        origin: origin(),
        host: `127.0.0.1:${String(port)}`,
      },
    })
    expect(res.statusCode, res.body).toBeLessThan(300)
    expect(await closesWithin(vw, 1000)).toBeLessThan(1000)
    expect(other.socket.readyState).toBe(WebSocket.OPEN)
    other.socket.close()
  })

  it('closes every socket of the account on a password reset', async () => {
    const a = await person('ed')
    const b = await person('ed')
    expect(await resetPassword(db, 'ed@test.invalid', 'a new long password')).toBe(true)
    await closesWithin(a, 1000)
    await closesWithin(b, 1000)
  })

  it('closes the socket of a removed member', async () => {
    const vw = await person('vw')
    const res = await as('own', 'DELETE', '/members/vw')
    expect(res.statusCode, res.body).toBe(204)
    await closesWithin(vw, 1000)
  })

  it('closes an agent socket within a second when its key is revoked', async () => {
    const key = await createKey('h1')
    const bot = await agent(key.secret)
    const other = await agent((await createKey('h1')).secret)
    const res = await as('own', 'POST', `/agent-keys/${key.key.id}/revoke`)
    expect(res.statusCode, res.body).toBe(200)
    await closesWithin(bot, 1000)
    expect(other.socket.readyState).toBe(WebSocket.OPEN)
    other.socket.close()
  })

  it('closes the sockets of keys on a deleted hub, subscribed or not', async () => {
    const key = await createKey('h3')
    const bot = await agent(key.secret)
    const own = await person('own')
    own.subscribe('h3', await counter())
    await changes(own)
    const hub = await as('own', 'GET', '/hubs/h3')
    const version = hub.json<{ hub: { version: number } }>().hub.version
    const res = await as('own', 'DELETE', `/hubs/h3?version=${String(version)}`)
    expect(res.statusCode, res.body).toBe(204)
    await closesWithin(bot, 1000)
    expect(await own.next()).toEqual({ type: 'access_lost', hubId: 'h3' })
    own.socket.close()
  })

  it('checks the session again periodically, so one ended without a notification closes too', async () => {
    const vw = await person('vw')
    // Expired in place: no NOTIFY, only the periodic check finds it.
    await db
      .updateTable('session')
      .set({
        created_at: sql<Date>`now() - interval '2 days'`,
        last_seen_at: sql<Date>`now() - interval '2 days'`,
        expires_at: sql<Date>`now() - interval '1 second'`,
      })
      .where('account_id', '=', 'acct-vw')
      .execute()
    await closesWithin(vw, RECHECK_MS * 3)
  })
})

describe('the LISTEN connection', () => {
  const listenerPids = async () =>
    (
      await sql<{ pid: number }>`
        SELECT pid FROM pg_stat_activity WHERE application_name = ${LISTENER_APPLICATION_NAME}
          AND datname = current_database()
      `.execute(db)
    ).rows.map((r) => r.pid)

  it('reconnects when Postgres drops it, then catches sockets up and has them reload hubs', async () => {
    const ed = await person('ed')
    ed.subscribe('h1', await counter())
    await changes(ed)
    const [pid] = await listenerPids()
    expect(pid).toBeDefined()
    await sql`SELECT pg_terminate_backend(${pid})`.execute(db)

    // Written while the listener is down: its notification is lost.
    const missed = await create('ed', 'h1', 'while down')
    // The schema may have changed in the gap too: every subscribed hub is announced again.
    const messages: FeedServerMessage[] = [await ed.next(5000), await ed.next(5000)]
    expect(messages).toContainEqual(expect.objectContaining({ type: 'hub', hubId: 'h1' }))
    const caught = messages.find((m) => m.type === 'changes')
    expect(caught?.type === 'changes' && caught.changes.map((c) => c.itemId)).toEqual([missed.id])
    const now = await listenerPids()
    expect(now).toHaveLength(1)
    expect(now[0]).not.toBe(pid)

    // And it keeps listening.
    const after = await create('ed', 'h1', 'after')
    expect((await changes(ed)).changes.map((c) => c.itemId)).toEqual([after.id])
    ed.socket.close()
  })
})

describe('a socket that misbehaves', () => {
  it(`closes a socket with more than ${String(MAX_PENDING_CLIENT_MESSAGES)} messages waiting, with 1008`, async () => {
    const ed = await person('ed')
    // Each subscribe costs a transaction; a burst far faster than they are answered.
    for (let i = 0; i < 300; i++) ed.subscribe('h1', 0)
    expect(await ed.closed).toBe(FEED_CLOSE_CODES.policy)

    // A burst at the cap, as the client rule allows: every message answered, in the order sent.
    const again = await person('ed')
    const hubs = Array.from({ length: MAX_PENDING_CLIENT_MESSAGES }, (_, i) =>
      i % 2 ? 'h2' : 'h1',
    )
    for (const hub of hubs) again.subscribe(hub, 0)
    const answered: string[] = []
    for (let i = 0; i < hubs.length; i++) answered.push(...(await changes(again)).hubIds)
    expect(answered).toEqual(hubs)
    expect(again.socket.readyState).toBe(WebSocket.OPEN)
    again.socket.close()
  })

  it('closes a frame over 64 KiB with frameTooLarge', async () => {
    const ed = await person('ed')
    ed.send('x'.repeat(64 * 1024 + 1))
    expect(await ed.closed).toBe(FEED_CLOSE_CODES.frameTooLarge)
  })

  it('terminates a socket that stops answering pings within about two ticks', async () => {
    const silent = await person('ed', WS, { autoPong: false })
    const live = await person('ed')
    const started = Date.now()
    // Terminated without a close frame: the client sees 1006.
    expect(await silent.closed).toBe(1006)
    expect(Date.now() - started).toBeLessThan(RECHECK_MS * 3)
    expect(live.socket.readyState).toBe(WebSocket.OPEN)
    // It no longer counts towards the session's sockets.
    live.socket.close()
  })
})
