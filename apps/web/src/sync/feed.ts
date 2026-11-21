import {
  FEED_CLOSE_CODES,
  feedServerMessageSchema,
  MAX_PENDING_CLIENT_MESSAGES,
  type FeedClientMessage,
  type FeedErrorCode,
  type FeedServerMessage,
} from '@16bit/core'
import { ref, type Ref } from 'vue'

// The change feed client (D57, D58): one WebSocket per tab and workspace, subscriptions per hub,
// resumed from each hub's high-water `seq` after a reconnect. The socket is opened only while a
// hub is tracked, and closed a little after the last one is let go.

/** The part of a WebSocket the client uses, so tests can drive a fake one. */
export interface FeedSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type SocketFactory = (url: string) => FeedSocket

/**
 * `idle`: nothing tracked, no socket. `connecting`: the first connection is opening.
 * `online`: open. `offline`: the connection dropped or failed; a reconnect is scheduled.
 * `stopped`: the server closed it for a reason a reconnect would not fix; live updates are off
 * until the page is loaded again.
 */
export type FeedStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

export interface FeedHandlers {
  changes(message: Extract<FeedServerMessage, { type: 'changes' }>): void
  hub(hubId: string, version: number): void
  /** The subscription ended because the reader can no longer read the hub. */
  accessLost(hubId: string): void
  /** The subscription ended because too much was missed: reload what is shown, then track again. */
  resync(hubId: string): void
  /** The server refused a subscription for a reason other than access (`too_many_subscriptions`). */
  refused(hubId: string, code: FeedErrorCode): void
  /**
   * The server closed the socket because the session or key ended (`credentialsEnded`, 4401):
   * the reader has to sign in again, and a reconnect would be refused.
   */
  credentialsEnded(): void
}

export interface FeedOptions {
  socket?: SocketFactory
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** 0 to 1, for the jitter on the reconnect delay. */
  random?: () => number
  /** How long the socket stays open after the last hub is let go, so a page change reuses it. */
  lingerMs?: number
}

/** First reconnect delay, doubled after each failed attempt up to `MAX_BACKOFF_MS`. */
export const FIRST_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 30_000
export const LINGER_MS = 10_000

/** The delay before reconnect attempt `attempt` (0-based): exponential, capped, with jitter. */
export function backoff(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(attempt, 16))
  // Between half and all of the ceiling, so tabs that dropped together do not return together.
  return Math.round(ceiling * (0.5 + random() / 2))
}

interface Subscription {
  /** The high-water `seq` this hub is known to be complete up to; a resume starts after it. */
  after: number
  /** The `after` of the last subscribe sent. A read older than this restarts the subscription. */
  startedAt: number
  /** The subscribe went out on the current socket (not still waiting in the outbox). */
  sent: boolean
}

export interface FeedClient {
  status: Ref<FeedStatus>
  /**
   * Keeps a hub live from a read at `seq`. The first call subscribes after `seq`. A later read
   * older than where the subscription started restarts it from that read, so nothing between
   * the read and the subscription is missed; a newer read changes nothing.
   */
  track(hubId: string, seq: number): void
  /** Stops a hub's changes. */
  untrack(hubId: string): void
  isTracked(hubId: string): boolean
  /** Where a hub's subscription would resume, for tests and diagnostics. */
  position(hubId: string): number | undefined
  /** Closes the socket for good. */
  close(): void
}

export function createFeed(
  url: string,
  handlers: FeedHandlers,
  options: FeedOptions = {},
): FeedClient {
  const open: SocketFactory = options.socket ?? ((u) => new WebSocket(u) as unknown as FeedSocket)
  const later = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const cancel =
    options.clearTimeout ??
    ((h) => {
      globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>)
    })
  const random = options.random ?? Math.random
  const lingerMs = options.lingerMs ?? LINGER_MS

  const status = ref<FeedStatus>('idle')
  const subs = new Map<string, Subscription>()
  let socket: FeedSocket | null = null
  let isOpen = false
  let attempt = 0
  let reconnectTimer: unknown = null
  let lingerTimer: unknown = null
  let closed = false
  /**
   * Messages sent since the last message received, and those waiting for an answer before they
   * may go: at most `MAX_PENDING_CLIENT_MESSAGES` are ever unanswered, so the server never
   * closes the socket for sending too fast.
   */
  let unanswered = 0
  let outbox: FeedClientMessage[] = []

  function flush() {
    while (socket && isOpen && outbox.length > 0 && unanswered < MAX_PENDING_CLIENT_MESSAGES) {
      const message = outbox.shift() as FeedClientMessage
      if (message.type === 'subscribe') {
        const sub = subs.get(message.hubId)
        // Let go, or restarted from another `after` since it was queued: the newer one goes.
        if (!sub || sub.after !== message.after) continue
        sub.sent = true
      }
      unanswered++
      socket.send(JSON.stringify(message))
    }
  }
  const send = (message: FeedClientMessage) => {
    if (!socket || !isOpen) return
    outbox.push(message)
    flush()
  }
  const subscribe = (hubId: string, sub: Subscription) => {
    if (!isOpen) return
    sub.sent = false
    send({ type: 'subscribe', hubId, after: sub.after })
  }

  function connect() {
    if (closed || socket || subs.size === 0) return
    if (status.value !== 'offline') status.value = 'connecting'
    let s: FeedSocket
    try {
      s = open(url)
    } catch {
      dropped()
      return
    }
    socket = s
    s.onopen = () => {
      if (socket !== s) return
      isOpen = true
      unanswered = 0
      outbox = []
      attempt = 0
      status.value = 'online'
      for (const [hubId, sub] of subs) subscribe(hubId, sub)
    }
    s.onmessage = (event) => {
      if (socket === s) receive(event.data)
    }
    s.onclose = (event) => {
      if (socket === s) dropped(event.code)
    }
    // A failed connection also fires `close`, which does the work.
    s.onerror = () => undefined
  }

  /**
   * The socket closed, or never opened. Per `FEED_CLOSE_CODES`: ended credentials send the
   * reader to sign in; a frame too large is a client bug a retry would repeat, so live updates
   * stop; everything else (going away, policy, internal, a network drop, a refused upgrade)
   * reconnects with backoff and resumes from the positions held.
   */
  function dropped(code?: number) {
    socket = null
    isOpen = false
    outbox = []
    unanswered = 0
    for (const sub of subs.values()) sub.sent = false
    if (closed || subs.size === 0) {
      status.value = 'idle'
      return
    }
    if (code === FEED_CLOSE_CODES.credentialsEnded) {
      status.value = 'stopped'
      handlers.credentialsEnded()
      return
    }
    if (code === FEED_CLOSE_CODES.frameTooLarge) {
      status.value = 'stopped'
      return
    }
    status.value = 'offline'
    if (reconnectTimer !== null) return
    reconnectTimer = later(
      () => {
        reconnectTimer = null
        connect()
      },
      backoff(attempt++, random),
    )
  }

  function receive(data: unknown) {
    if (typeof data !== 'string') return
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      return
    }
    const parsed = feedServerMessageSchema.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    // Any message received makes room for the next ones waiting (MAX_PENDING_CLIENT_MESSAGES).
    unanswered = 0
    flush()
    switch (message.type) {
      case 'changes':
        // The high-water mark covers only the hubs the message names (D58).
        for (const hubId of message.hubIds) {
          const sub = subs.get(hubId)
          if (sub?.sent) sub.after = Math.max(sub.after, message.seq)
        }
        handlers.changes(message)
        return
      case 'hub':
        handlers.hub(message.hubId, message.version)
        return
      case 'access_lost':
        subs.delete(message.hubId)
        handlers.accessLost(message.hubId)
        return
      case 'resync':
        subs.delete(message.hubId)
        handlers.resync(message.hubId)
        return
      case 'error': {
        const hubId = message.hubId
        if (!hubId || !subs.has(hubId)) return
        if (message.code === 'not_found') {
          // Missing, hidden, or no longer shared answer alike (D57); either way it is out of reach.
          subs.delete(hubId)
          handlers.accessLost(hubId)
        } else if (message.code === 'too_many_subscriptions') {
          subs.delete(hubId)
          handlers.refused(hubId, message.code)
        }
        return
      }
    }
  }

  function track(hubId: string, seq: number) {
    if (closed || status.value === 'stopped') return
    if (lingerTimer !== null) {
      cancel(lingerTimer)
      lingerTimer = null
    }
    const sub = subs.get(hubId)
    if (!sub) {
      const created: Subscription = { after: seq, startedAt: seq, sent: false }
      subs.set(hubId, created)
      subscribe(hubId, created)
      // While offline, the scheduled reconnect picks it up; the backoff is not cut short.
      if (reconnectTimer === null) connect()
      return
    }
    if (seq < sub.startedAt) {
      sub.after = seq
      sub.startedAt = seq
      subscribe(hubId, sub)
    }
  }

  function untrack(hubId: string) {
    if (!subs.delete(hubId)) return
    outbox = outbox.filter((m) => m.hubId !== hubId)
    send({ type: 'unsubscribe', hubId })
    if (subs.size > 0) return
    if (reconnectTimer !== null) {
      cancel(reconnectTimer)
      reconnectTimer = null
    }
    if (!socket) {
      status.value = 'idle'
      return
    }
    lingerTimer = later(() => {
      lingerTimer = null
      if (subs.size > 0 || !socket) return
      const s = socket
      socket = null
      isOpen = false
      status.value = 'idle'
      s.close(1000, 'idle')
    }, lingerMs)
  }

  function close() {
    closed = true
    subs.clear()
    for (const t of [reconnectTimer, lingerTimer]) if (t !== null) cancel(t)
    reconnectTimer = lingerTimer = null
    const s = socket
    socket = null
    isOpen = false
    outbox = []
    status.value = 'idle'
    s?.close(1000, 'closed')
  }

  return {
    status,
    track,
    untrack,
    isTracked: (hubId) => subs.has(hubId),
    position: (hubId) => subs.get(hubId)?.after,
    close,
  }
}

/** The feed URL for a workspace, on the page's own origin (D57). */
export function feedUrl(
  workspaceId: string,
  location: Pick<Location, 'protocol' | 'host'>,
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/v1/workspaces/${encodeURIComponent(workspaceId)}/feed`
}
