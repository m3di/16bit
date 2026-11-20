import type { FeedClientMessage, FeedServerMessage } from '@16bit/core'
import { createFeed, type FeedHandlers, type FeedSocket } from './feed.ts'
import { createWorkspaceStore } from './store.ts'

// A fake WebSocket and clock for the feed client. Only imported by tests.

export class FakeSocket implements FeedSocket {
  onopen: FeedSocket['onopen'] = null
  onmessage: FeedSocket['onmessage'] = null
  onclose: FeedSocket['onclose'] = null
  onerror: FeedSocket['onerror'] = null
  sent: FeedClientMessage[] = []
  closed = false

  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as FeedClientMessage)
  }
  close() {
    this.closed = true
  }
  /** The server accepts the connection. */
  open() {
    this.onopen?.({})
  }
  /** The server sends a message. */
  push(message: FeedServerMessage | string) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) })
  }
  /** The connection drops, or never opened. */
  drop() {
    this.onclose?.({})
  }
}

/** Timers run by hand: `advance(ms)` fires the ones that are due, in order. */
export function fakeClock() {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++next
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number)
    },
    /** Delays of the timers waiting, from now. */
    pending: () => [...timers.values()].map((t) => t.at - now),
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
  }
}

/** A feed client on fake sockets; `sockets` holds every socket it opened, newest last. */
export function fakeFeed(handlers: FeedHandlers) {
  const sockets: FakeSocket[] = []
  const clock = fakeClock()
  const feed = createFeed('ws://x/v1/workspaces/w/feed', handlers, {
    socket: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 1,
  })
  return { feed, sockets, clock, socket: () => sockets.at(-1) }
}

/** A store whose feed runs on fake sockets. */
export function liveStore(workspaceId = 'w') {
  let made: ReturnType<typeof fakeFeed> | null = null
  const store = createWorkspaceStore(workspaceId, (handlers) => {
    made = fakeFeed(handlers)
    return made.feed
  })
  const fake = made as unknown as ReturnType<typeof fakeFeed>
  return { store, ...fake }
}
