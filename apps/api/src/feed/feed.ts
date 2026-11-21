import {
  FEED_CLOSE_CODES,
  MAX_MISSED_CHANGES,
  MAX_PENDING_CLIENT_MESSAGES,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  parseFeedClientMessage,
  type Change,
  type FeedServerMessage,
  type Subject,
} from '@16bit/core'
import type { Kysely, Transaction } from 'kysely'
import type { WebSocket } from 'ws'
import { checkHub, loadSubject } from '../access.ts'
import { resolveAgentKeyHash } from '../auth/agent-key.ts'
import { sessionLive, type SessionPolicy } from '../auth/session.ts'
import { readChangesBatch } from '../changes.ts'
import type { Database } from '../db/database.ts'
import { withScope } from '../db/scope.ts'
import { HttpError } from '../http.ts'
import { REVISION_CHANNEL } from '../items.ts'
import {
  ACCESS_CHANNEL,
  HUB_CHANNEL,
  SESSION_CHANNEL,
  type AccessNotice,
  type HubNotice,
  type SessionNotice,
} from '../notify.ts'
import { Listener } from './listener.ts'

// The change feed (D57, D58). One `Feed` per process: it owns the `LISTEN` connection and every
// open socket. Each socket (`Connection`) handles its work one task at a time, in order: client
// messages, catch-ups and notifications. So a `subscribe` is answered by that hub's catch-up
// (`changes` with `hubIds: [hubId]`, or `resync`, or `error`) before the hub shows up in any later
// message, and a `changes` message's `hubIds` are exactly the hubs it brings up to `seq`.
//
// Every read runs under the socket's own principal (row-level security, as for a GET), in one
// REPEATABLE READ READ ONLY transaction, through the same reader as `GET /changes`.

/** Most sockets one session (or agent key) holds open at once. */
export const MAX_SOCKETS_PER_SESSION = 10
/**
 * Most bytes waiting to go out to one socket. A client that stops reading is closed (1011,
 * reconnect and resume) instead of the server buffering every change for it.
 */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/**
 * Most bytes (UTF-8 JSON) of one `changes` message, short of a single change larger than that.
 * A read of up to `MAX_MISSED_CHANGES` changes, each with an item and a cause of up to about
 * 21 KB (D63), is split into several messages of at most this size (#197).
 */
export const MAX_CHANGES_MESSAGE_BYTES = 256 * 1024
/**
 * How long a socket may take to make room for the next part of a split `changes` batch before it
 * is treated as not reading (closed with 1011, like `MAX_BUFFERED_BYTES`).
 */
export const DRAIN_TIMEOUT_MS = 10_000

type ChangesMessage = Extract<FeedServerMessage, { type: 'changes' }>

/**
 * One read's changes for `hubIds` as `changes` messages of at most `maxBytes` each (one change
 * larger than that goes alone). Every message but the last reports its last change's `seq` as
 * its high-water mark, as a batch cut short by a limit does (D58): changes are in `seq` order,
 * so every change the subscriber may see up to it has been sent. The last reports `seq`.
 */
export function splitChanges(
  seq: number,
  hubIds: string[],
  changes: Change[],
  maxBytes: number = MAX_CHANGES_MESSAGE_BYTES,
): ChangesMessage[] {
  const header = Buffer.byteLength(JSON.stringify({ type: 'changes', seq, hubIds, changes: [] }))
  const parts: Change[][] = []
  let part: Change[] = []
  let size = header
  for (const change of changes) {
    // The comma between changes counts too.
    const bytes = Buffer.byteLength(JSON.stringify(change)) + 1
    if (part.length > 0 && size + bytes > maxBytes) {
      parts.push(part)
      part = []
      size = header
    }
    part.push(change)
    size += bytes
  }
  parts.push(part)
  return parts.map((p, i) => ({
    type: 'changes',
    seq: i === parts.length - 1 ? seq : (p.at(-1)?.seq ?? seq),
    hubIds,
    changes: p,
  }))
}

const {
  credentialsEnded: CLOSE_CREDENTIALS_ENDED,
  policy: CLOSE_POLICY,
  internal: CLOSE_INTERNAL,
  goingAway: CLOSE_GOING_AWAY,
} = FEED_CLOSE_CODES

export interface FeedOptions {
  /** Connection string for the `LISTEN` connection: the API's own role (DATABASE_URL). */
  listenUrl: string
  /** Notifications for one workspace are gathered this long before reading (D58). */
  coalesceMs?: number
  /**
   * How often each socket's session or key and membership are checked again (D58), and each
   * socket pinged: one that has not answered the previous ping by then is terminated.
   */
  recheckMs?: number
  /** `MAX_BUFFERED_BYTES`; lowered in tests. */
  maxBufferedBytes?: number
  /** `DRAIN_TIMEOUT_MS`; lowered in tests. */
  drainTimeoutMs?: number
  /** Past this many missed changes the subscriber could see, `resync`. Lowered in tests. */
  maxMissedChanges?: number
  /** Passed to the reader; lowered in tests. */
  maxScan?: number
  /** First reconnect delay of the `LISTEN` connection. */
  listenRetryMs?: number
}

/** Who holds the socket, as resolved before the upgrade. */
export type FeedCredential =
  | { kind: 'session'; sessionIdHash: string; accountId: string }
  | { kind: 'agent'; keyHash: string; principalId: string; hubId: string }

export interface ConnectionContext {
  workspaceId: string
  principal: Subject
  credential: FeedCredential
}

const credentialKey = (c: FeedCredential) =>
  c.kind === 'session' ? `s:${c.sessionIdHash}` : `a:${c.principalId}`

type Trx = Transaction<Database>
type Batch = Awaited<ReturnType<typeof readChangesBatch>>

export class Feed {
  readonly db: Kysely<Database>
  readonly session: SessionPolicy
  readonly maxMissed: number
  readonly maxScan: number | undefined
  readonly maxBuffered: number
  readonly drainTimeoutMs: number
  readonly #coalesceMs: number
  readonly #recheckMs: number
  readonly #listener: Listener
  readonly #byWorkspace = new Map<string, Set<Connection>>()
  readonly #byCredential = new Map<string, Set<Connection>>()
  readonly #pending = new Map<string, { seq: number; timer: ReturnType<typeof setTimeout> }>()
  #recheckTimer: ReturnType<typeof setInterval> | null = null
  #closed = false

  constructor(db: Kysely<Database>, session: SessionPolicy, options: FeedOptions) {
    this.db = db
    this.session = session
    this.maxMissed = options.maxMissedChanges ?? MAX_MISSED_CHANGES
    this.maxScan = options.maxScan
    this.maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES
    this.drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
    this.#coalesceMs = options.coalesceMs ?? 50
    this.#recheckMs = options.recheckMs ?? 60_000
    this.#listener = new Listener(
      options.listenUrl,
      {
        notification: (channel, payload) => {
          this.#notification(channel, payload)
        },
        connected: () => {
          this.#connected()
        },
      },
      { retryMs: options.listenRetryMs },
    )
  }

  get listening(): boolean {
    return this.#listener.listening
  }

  async start(): Promise<void> {
    await this.#listener.start()
    this.#recheckTimer = setInterval(() => {
      void this.#listener.check(Math.min(10_000, this.#recheckMs))
      for (const conn of this.#all()) {
        // A half-open socket (a network that dropped without a FIN) never answers a ping.
        if (!conn.heartbeat()) continue
        conn.enqueue(() => conn.recheckCredential())
      }
    }, this.#recheckMs)
    this.#recheckTimer.unref()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#recheckTimer) clearInterval(this.#recheckTimer)
    for (const { timer } of this.#pending.values()) clearTimeout(timer)
    this.#pending.clear()
    for (const conn of this.#all()) conn.close(CLOSE_GOING_AWAY, 'Server shutting down')
    await this.#listener.close()
  }

  /** Sockets this credential holds open now. */
  socketCount(credential: FeedCredential): number {
    return this.#byCredential.get(credentialKey(credential))?.size ?? 0
  }

  /** Takes over an upgraded socket. */
  accept(socket: WebSocket, context: ConnectionContext): void {
    if (this.#closed) {
      socket.close(CLOSE_GOING_AWAY, 'Server shutting down')
      return
    }
    if (this.socketCount(context.credential) >= MAX_SOCKETS_PER_SESSION) {
      socket.close(CLOSE_POLICY, 'Too many sockets for this session')
      return
    }
    const conn = new Connection(this, socket, context)
    add(this.#byWorkspace, context.workspaceId, conn)
    add(this.#byCredential, credentialKey(context.credential), conn)
  }

  /** Called by a connection once its socket has closed. */
  forget(conn: Connection): void {
    remove(this.#byWorkspace, conn.context.workspaceId, conn)
    remove(this.#byCredential, credentialKey(conn.context.credential), conn)
  }

  /** Runs `fn` as the connection's principal in one read-only snapshot (D58). */
  read<T>(context: ConnectionContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return withScope(
      this.db,
      { workspaceId: context.workspaceId, principalId: context.principal.id },
      fn,
      { snapshot: true },
    )
  }

  *#all(): Iterable<Connection> {
    for (const set of this.#byWorkspace.values()) yield* set
  }

  #notification(channel: string, payload: string): void {
    try {
      if (channel === REVISION_CHANNEL) {
        const colon = payload.lastIndexOf(':')
        const seq = Number(payload.slice(colon + 1))
        if (colon > 0 && Number.isFinite(seq)) this.#revision(payload.slice(0, colon), seq)
      } else if (channel === HUB_CHANNEL) {
        this.#hub(JSON.parse(payload) as HubNotice)
      } else if (channel === ACCESS_CHANNEL) {
        this.#access(JSON.parse(payload) as AccessNotice)
      } else if (channel === SESSION_CHANNEL) {
        this.#session(JSON.parse(payload) as SessionNotice)
      }
    } catch (error) {
      console.error(`feed: unreadable ${channel} notification: ${(error as Error).message}`)
    }
  }

  /**
   * Revisions are gathered per workspace for `coalesceMs`, then every socket there reads once.
   * A notification only says that something up to `seq` was written: the read takes everything
   * after each hub's own position, so one NOTIFY for many revisions (`pnpm seed:large` sends one
   * per chunk) loses nothing.
   */
  #revision(workspaceId: string, seq: number): void {
    if (!this.#byWorkspace.has(workspaceId)) return
    const pending = this.#pending.get(workspaceId)
    if (pending) {
      pending.seq = Math.max(pending.seq, seq)
      return
    }
    const timer = setTimeout(() => {
      const done = this.#pending.get(workspaceId)
      this.#pending.delete(workspaceId)
      if (!done) return
      for (const conn of this.#byWorkspace.get(workspaceId) ?? []) conn.requestPump(done.seq)
    }, this.#coalesceMs)
    this.#pending.set(workspaceId, { seq, timer })
  }

  /**
   * One `hub` event per notification to each subscriber who can still read it (D58). Deleting a
   * hub revokes its agent keys in SQL with only this notice, no `access` one, so an agent socket
   * on the hub checks its key at once, and closes if the key is gone, subscribed or not.
   */
  #hub(notice: HubNotice): void {
    for (const conn of this.#byWorkspace.get(notice.workspaceId) ?? []) {
      const c = conn.context.credential
      if (c.kind === 'agent' && c.hubId === notice.hubId) {
        conn.enqueue(() => conn.recheckCredential())
      }
      if (conn.subscribed(notice.hubId)) {
        conn.enqueue(() => conn.recheckHubs([notice.hubId], true))
      }
    }
  }

  #access(notice: AccessNotice): void {
    for (const conn of this.#byWorkspace.get(notice.workspaceId) ?? []) {
      if (conn.context.principal.id !== notice.target) continue
      if (notice.action === 'member.remove' || notice.action === 'key.revoke') {
        conn.close(CLOSE_CREDENTIALS_ENDED, 'Access ended')
      } else {
        // A grant or role changed: the principal may have lost hubs it subscribes to.
        conn.enqueue(() => conn.recheckSubject())
      }
    }
  }

  #session(notice: SessionNotice): void {
    for (const conn of this.#all()) {
      const c = conn.context.credential
      if (c.kind !== 'session') continue
      const hit =
        'sessionIdHash' in notice
          ? c.sessionIdHash === notice.sessionIdHash
          : c.accountId === notice.accountId
      if (hit) conn.close(CLOSE_CREDENTIALS_ENDED, 'Signed out')
    }
  }

  /**
   * On every successful connect of the `LISTEN` connection, the first one included: whatever was
   * sent while it was down (or before it first came up) is lost. Check every socket's credential
   * and hubs again, send `hub` for each subscribed hub (its schema may have changed), and catch
   * every socket up from its own positions. With no sockets open it does nothing.
   */
  #connected(): void {
    for (const conn of this.#all()) {
      conn.enqueue(() => conn.recheckCredential())
      conn.enqueue(() => conn.recheckHubs(conn.hubIds(), true))
      conn.requestPump(Number.MAX_SAFE_INTEGER)
    }
  }
}

/** One socket: its subscriptions and its queue of work, run one task at a time. */
export class Connection {
  readonly feed: Feed
  readonly socket: WebSocket
  context: ConnectionContext
  /** Hub ID to the `seq` it is complete up to, as last told to the client. */
  readonly #subs = new Map<string, number>()
  #queue: Promise<void> = Promise.resolve()
  #pumpQueued = false
  #closed = false
  /** Client messages received and not yet handled. */
  #pendingMessages = 0
  /** Answered the last ping (or was opened since the last tick). */
  #alive = true

  constructor(feed: Feed, socket: WebSocket, context: ConnectionContext) {
    this.feed = feed
    this.socket = socket
    this.context = context
    // Attached at once, so no message is dropped while earlier work runs.
    socket.on('message', (data, isBinary) => {
      // Each waiting message holds up to 64 KiB and a subscribe costs a transaction: a client
      // sending faster than it is answered is closed rather than queued without bound.
      if (this.#pendingMessages >= MAX_PENDING_CLIENT_MESSAGES) {
        this.close(CLOSE_POLICY, 'Too many messages waiting for an answer')
        return
      }
      this.#pendingMessages += 1
      const text = isBinary ? null : Buffer.isBuffer(data) ? data.toString('utf8') : null
      this.enqueue(async () => {
        try {
          await this.#message(text ?? '')
        } finally {
          this.#pendingMessages -= 1
        }
      })
    })
    socket.on('pong', () => {
      this.#alive = true
    })
    socket.on('close', () => {
      this.#closed = true
      feed.forget(this)
    })
    socket.on('error', () => undefined)
  }

  subscribed(hubId: string): boolean {
    return this.#subs.has(hubId)
  }

  hubIds(): string[] {
    return [...this.#subs.keys()]
  }

  /**
   * The recheck tick: terminates the socket if it has not answered the previous ping, else pings
   * it again. Returns whether the socket is still open.
   */
  heartbeat(): boolean {
    if (this.#closed) return false
    if (!this.#alive) {
      this.#closed = true
      this.socket.terminate()
      this.feed.forget(this)
      return false
    }
    this.#alive = false
    this.socket.ping()
    return true
  }

  close(code: number, reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.socket.close(code, reason)
    this.feed.forget(this)
  }

  /** Runs `task` after everything queued before it. A failed task closes the socket. */
  enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue
      .then(() => (this.#closed ? undefined : task()))
      .catch((error: unknown) => {
        console.error(`feed: ${(error as Error).message}`)
        // The client reconnects and resumes from its positions; nothing is skipped.
        this.close(CLOSE_INTERNAL, 'Internal error')
      })
  }

  /** Queues one read of everything new, unless one is already waiting or nothing is behind. */
  requestPump(seq: number): void {
    if (this.#pumpQueued || this.#closed) return
    if (![...this.#subs.values()].some((after) => after < seq)) return
    this.#pumpQueued = true
    this.enqueue(async () => {
      this.#pumpQueued = false
      await this.#pump()
    })
  }

  /**
   * Waits until `bytes` more fit under the socket's send limit (D58). False, with the socket
   * closed as for a client that stopped reading, if it is closed or makes no room in time.
   */
  async #room(bytes: number): Promise<boolean> {
    const limit = Math.max(0, this.feed.maxBuffered - bytes)
    const started = Date.now()
    while (this.socket.bufferedAmount > limit) {
      if (this.#closed || this.socket.readyState !== this.socket.OPEN) return false
      if (Date.now() - started > this.feed.drainTimeoutMs) {
        this.close(CLOSE_INTERNAL, 'Client is not reading')
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return true
  }

  #send(message: FeedServerMessage): void {
    if (this.#closed || this.socket.readyState !== this.socket.OPEN) return
    if (this.socket.bufferedAmount > this.feed.maxBuffered) {
      // The client stopped reading. It resumes from its positions once it reconnects.
      this.close(CLOSE_INTERNAL, 'Client is not reading')
      return
    }
    this.#sendText(JSON.stringify(message))
  }

  #sendText(text: string): void {
    if (this.#closed || this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(text)
  }

  async #message(text: string): Promise<void> {
    const parsed = parseFeedClientMessage(text)
    if (!parsed.ok) {
      this.#send({ type: 'error', code: parsed.code, message: parsed.message })
      return
    }
    const { message } = parsed
    if (message.type === 'unsubscribe') {
      this.#subs.delete(message.hubId)
      return
    }
    await this.#subscribe(message.hubId, message.after)
  }

  /** Starts, or restarts from the new `after`, one hub, answered by its catch-up. */
  async #subscribe(hubId: string, after: number): Promise<void> {
    if (!this.#subs.has(hubId) && this.#subs.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
      this.#send({
        type: 'error',
        code: 'too_many_subscriptions',
        message: `At most ${String(MAX_SUBSCRIPTIONS_PER_SOCKET)} hubs per socket`,
        hubId,
      })
      return
    }
    // A restart ends the old subscription first, whatever the answer.
    this.#subs.delete(hubId)
    const result = await this.feed.read(this.context, async (trx) => {
      if ((await hubVersion(trx, this.context, hubId)) === null) return null
      return this.#readBatch(trx, after, [hubId])
    })
    if (result === null) {
      // Missing, hidden, or not the agent's own: one answer for all three (D57).
      this.#send({ type: 'error', code: 'not_found', message: 'Hub not found', hubId })
      return
    }
    await this.#deliver([hubId], result)
  }

  #readBatch(trx: Trx, after: number, hubIds: string[]): Promise<Batch> {
    return readChangesBatch(trx, this.context.workspaceId, {
      // The writer's `clientMutationId` is echoed only to the writer's own sockets.
      principalId: this.context.principal.id,
      after,
      limit: this.feed.maxMissed,
      hubIds,
      maxScan: this.feed.maxScan,
    })
  }

  /** Sends one read's result for `hubIds` and moves them to its high-water mark. */
  async #deliver(hubIds: string[], result: Batch): Promise<void> {
    if (result.cut) {
      // More than the subscriber could take in: it reloads and subscribes again (D58).
      for (const hubId of hubIds) {
        this.#subs.delete(hubId)
        this.#send({ type: 'resync', hubId })
      }
      return
    }
    const { page } = result
    // Several messages when the batch is large, each sent once the socket has room for it, so
    // a healthy client is never pushed to the send limit by a large batch (#197).
    for (const message of splitChanges(page.seq, hubIds, page.changes)) {
      const text = JSON.stringify(message)
      if (!(await this.#room(Buffer.byteLength(text)))) return
      this.#sendText(text)
    }
    for (const hubId of hubIds) this.#subs.set(hubId, page.seq)
    if (page.more) this.requestPump(Number.MAX_SAFE_INTEGER)
  }

  /**
   * Reads everything new for every subscribed hub: one read per group of hubs at the same
   * position, which after the first catch-up is all of them. A group whose read is cut short
   * by the missed-changes cap is read again hub by hub, so only a hub past it gets `resync`.
   */
  async #pump(): Promise<void> {
    const groups = new Map<number, string[]>()
    for (const [hubId, after] of this.#subs) {
      const group = groups.get(after)
      if (group) group.push(hubId)
      else groups.set(after, [hubId])
    }
    for (const [after, hubIds] of groups) {
      const result = await this.feed.read(this.context, (trx) =>
        this.#readBatch(trx, after, hubIds),
      )
      if (result.page.seq <= after) continue
      if (result.cut && hubIds.length > 1) {
        for (const hubId of hubIds) {
          const one = await this.feed.read(this.context, (trx) =>
            this.#readBatch(trx, after, [hubId]),
          )
          if (one.page.seq > after || one.cut) await this.#deliver([hubId], one)
        }
        continue
      }
      await this.#deliver(hubIds, result)
    }
  }

  /**
   * Checks `hubIds` (those still subscribed) again: `access_lost` and the end of the
   * subscription for each the principal can no longer read, and with `announce`, a `hub` event
   * with the hub's version for each it still can.
   */
  async recheckHubs(hubIds: readonly string[], announce: boolean): Promise<void> {
    const live = hubIds.filter((h) => this.#subs.has(h))
    if (live.length === 0) return
    const versions = await this.feed.read(this.context, async (trx) => {
      const out = new Map<string, number | null>()
      for (const hubId of live) out.set(hubId, await hubVersion(trx, this.context, hubId))
      return out
    })
    for (const [hubId, version] of versions) {
      if (!this.#subs.has(hubId)) continue
      if (version === null) {
        this.#subs.delete(hubId)
        this.#send({ type: 'access_lost', hubId })
      } else if (announce) {
        this.#send({ type: 'hub', hubId, version })
      }
    }
  }

  /** Reloads the principal (its role may have changed), then checks every hub again. */
  async recheckSubject(): Promise<void> {
    const { workspaceId, principal } = this.context
    const subject = await this.feed.read(this.context, (trx) =>
      loadSubject(trx, workspaceId, principal.id),
    )
    if (!subject) {
      this.close(CLOSE_CREDENTIALS_ENDED, 'Access ended')
      return
    }
    this.context = { ...this.context, principal: subject }
    await this.recheckHubs(this.hubIds(), false)
  }

  /** The periodic check (D58): the session or key is still live, and so is the membership. */
  async recheckCredential(): Promise<void> {
    const { credential, workspaceId } = this.context
    const live =
      credential.kind === 'session'
        ? await sessionLive(this.feed.db, credential.sessionIdHash, this.feed.session)
        : (await resolveAgentKeyHash(this.feed.db, credential.keyHash))?.workspaceId === workspaceId
    if (!live) {
      this.close(CLOSE_CREDENTIALS_ENDED, 'Session ended')
      return
    }
    await this.recheckSubject()
  }
}

/**
 * The hub's version if `context`'s principal may read it, else null: missing, hidden, and (for
 * an agent) another hub's all look the same (D57).
 */
async function hubVersion(
  trx: Trx,
  context: ConnectionContext,
  hubId: string,
): Promise<number | null> {
  try {
    await checkHub(trx, context.workspaceId, context.principal, hubId, 'hub.read', 'Hub')
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null
    throw error
  }
  const row = await trx
    .selectFrom('folder')
    .select('version')
    .where('workspace_id', '=', context.workspaceId)
    .where('id', '=', hubId)
    .where('parent_id', 'is', null)
    .executeTakeFirst()
  return row?.version ?? null
}

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key)
  if (set) set.add(value)
  else map.set(key, new Set([value]))
}

function remove<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}
