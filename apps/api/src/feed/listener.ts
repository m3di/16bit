import pg from 'pg'
import { REVISION_CHANNEL } from '../items.ts'
import { ACCESS_CHANNEL, HUB_CHANNEL, SESSION_CHANNEL } from '../notify.ts'

// The process's one dedicated `LISTEN` connection (D58). Outside the pool: a pooled connection
// would be handed to queries and lose its LISTENs. When Postgres drops it (a restart,
// `pg_terminate_backend`, a network drop) it reconnects with backoff, as the pool does (#107),
// and reports `connected` on every successful connect, the first included: notifications sent
// while it was down (or before it first came up) are lost, so the feed catches every socket up
// from its own positions.

export const FEED_CHANNELS = [REVISION_CHANNEL, HUB_CHANNEL, ACCESS_CHANNEL, SESSION_CHANNEL]

/** `application_name` of the connection, so an operator (or a test) can find it. */
export const LISTENER_APPLICATION_NAME = '16bit-feed-listener'

export interface ListenerHandlers {
  notification(channel: string, payload: string): void
  /** Connected and listening, the first time or again after a drop. */
  connected(): void
}

export interface ListenerOptions {
  /** First delay before reconnecting, doubled per failed attempt up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
}

export class Listener {
  readonly #url: string
  readonly #handlers: ListenerHandlers
  readonly #retryMs: number
  readonly #maxRetryMs: number
  #client: pg.Client | null = null
  /** Gives up on the current connection and schedules a reconnect. */
  #drop: (() => void) | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #attempt = 0
  #closed = false

  constructor(url: string, handlers: ListenerHandlers, options: ListenerOptions = {}) {
    this.#url = url
    this.#handlers = handlers
    this.#retryMs = options.retryMs ?? 250
    this.#maxRetryMs = options.maxRetryMs ?? 5000
  }

  /** True while the connection is up and listening. */
  get listening(): boolean {
    return this.#client !== null
  }

  /** Connects. Resolves after the first attempt, connected or not; failures keep retrying. */
  async start(): Promise<void> {
    await this.#connect()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    const client = this.#client
    this.#client = null
    if (client) await client.end().catch(() => undefined)
  }

  async #connect(): Promise<void> {
    if (this.#closed) return
    const client = new pg.Client({
      connectionString: this.#url,
      application_name: LISTENER_APPLICATION_NAME,
      // TCP keepalive from 10 s idle, not the OS default (2 h on Linux). `check()` on the feed's
      // tick is the faster guard; this one also covers a feed with no tick running.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
    let lost = false
    const onLost = (error?: Error) => {
      if (lost) return
      lost = true
      if (this.#client === client) {
        this.#client = null
        this.#drop = null
      }
      if (this.#closed) return
      if (error) console.error(`feed: LISTEN connection lost, reconnecting: ${error.message}`)
      this.#retry()
    }
    // Without an `error` listener a dropped socket would crash the process (#107).
    client.on('error', onLost)
    client.on('end', () => {
      onLost()
    })
    client.on('notification', (n) => {
      if (n.payload !== undefined) this.#handlers.notification(n.channel, n.payload)
    })
    try {
      await client.connect()
      for (const channel of FEED_CHANNELS) {
        await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`)
      }
    } catch (error) {
      await client.end().catch(() => undefined)
      onLost(error as Error)
      return
    }
    // Closed, or the connection dropped, while LISTEN was being set up.
    if (this.#stale(lost)) {
      await client.end().catch(() => undefined)
      return
    }
    this.#client = client
    this.#drop = () => {
      onLost(new Error('no answer to the health check'))
      // Not `end()`: on a half-open connection it waits for TCP to give up. Destroying the
      // socket frees it at once; the client is already discarded.
      ;(
        client as unknown as { connection?: { stream?: { destroy(): void } } }
      ).connection?.stream?.destroy()
    }
    this.#attempt = 0
    this.#handlers.connected()
  }

  /**
   * `SELECT 1` on the connection, given up after `timeoutMs`: a silently dropped connection
   * (no FIN, no RST) would otherwise look healthy and deliver nothing. On failure it reconnects.
   */
  async check(timeoutMs: number): Promise<void> {
    const client = this.#client
    const drop = this.#drop
    if (!client || !drop) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ok = await Promise.race([
      client.query('SELECT 1').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => {
          done(false)
        }, timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (!ok && this.#client === client) drop()
  }

  #stale(lost: boolean): boolean {
    return this.#closed || lost
  }

  #retry(): void {
    if (this.#closed || this.#timer) return
    const delay = Math.min(this.#maxRetryMs, this.#retryMs * 2 ** Math.min(this.#attempt, 16))
    this.#attempt += 1
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#connect()
    }, delay)
  }
}
