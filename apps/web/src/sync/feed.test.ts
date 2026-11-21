import { describe, expect, it, vi } from 'vitest'
import {
  FEED_CLOSE_CODES,
  MAX_PENDING_CLIENT_MESSAGES,
  type Change,
  type FeedServerMessage,
} from '@16bit/core'
import { backoff, feedUrl, LINGER_MS, MAX_BACKOFF_MS, type FeedHandlers } from './feed.ts'
import { fakeFeed } from './fake-feed.test-utils.ts'

const handlers = () =>
  ({
    changes: vi.fn(),
    hub: vi.fn(),
    accessLost: vi.fn(),
    resync: vi.fn(),
    refused: vi.fn(),
    credentialsEnded: vi.fn(),
  }) satisfies FeedHandlers

const subscribe = (hubId: string, after: number) => ({ type: 'subscribe', hubId, after })

describe('feed client: connecting and subscribing', () => {
  it('opens no socket until a hub is tracked', () => {
    const { sockets, feed } = fakeFeed(handlers())
    expect(sockets).toHaveLength(0)
    expect(feed.status.value).toBe('idle')
  })

  it('subscribes with the seq of the read once the socket opens', () => {
    const { feed, socket } = fakeFeed(handlers())
    feed.track('bld', 41)
    expect(feed.status.value).toBe('connecting')
    expect(socket()?.url).toBe('ws://x/v1/workspaces/w/feed')
    expect(socket()?.sent).toEqual([])
    socket()?.open()
    expect(feed.status.value).toBe('online')
    expect(socket()?.sent).toEqual([subscribe('bld', 41)])
  })

  it('uses one socket for every hub', () => {
    const { feed, sockets, socket } = fakeFeed(handlers())
    feed.track('a', 1)
    socket()?.open()
    feed.track('b', 2)
    expect(sockets).toHaveLength(1)
    expect(socket()?.sent).toEqual([subscribe('a', 1), subscribe('b', 2)])
  })

  it('restarts a subscription from an older read, and ignores a newer one', () => {
    const { feed, socket } = fakeFeed(handlers())
    feed.track('bld', 20)
    socket()?.open()
    feed.track('bld', 25)
    feed.track('bld', 12)
    expect(socket()?.sent).toEqual([subscribe('bld', 20), subscribe('bld', 12)])
    expect(feed.position('bld')).toBe(12)
  })

  it('moves only the hubs a message names to its high-water seq, also with no change in it', () => {
    const h = handlers()
    const { feed, socket } = fakeFeed(h)
    feed.track('a', 5)
    feed.track('b', 7)
    socket()?.open()
    const message = {
      type: 'changes',
      seq: 30,
      hubIds: ['a'],
      changes: [],
    } satisfies FeedServerMessage
    socket()?.push(message)
    expect(feed.position('a')).toBe(30)
    expect(feed.position('b')).toBe(7)
    expect(h.changes).toHaveBeenCalledWith(message)
  })

  it('ignores messages that are not JSON or not in the protocol', () => {
    const h = handlers()
    const { feed, socket } = fakeFeed(h)
    feed.track('a', 5)
    socket()?.open()
    socket()?.push('not json')
    socket()?.push(JSON.stringify({ type: 'changes', seq: -1, hubIds: ['a'], changes: [] }))
    expect(h.changes).not.toHaveBeenCalled()
    expect(feed.position('a')).toBe(5)
  })

  it('builds the URL on the page origin', () => {
    expect(feedUrl('w 1', { protocol: 'https:', host: 'a.b' })).toBe(
      'wss://a.b/v1/workspaces/w%201/feed',
    )
    expect(feedUrl('w', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/v1/workspaces/w/feed',
    )
  })
})

describe('feed client: reconnecting', () => {
  it('backs off exponentially up to 30 seconds, with jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoff(n, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ])
    expect(backoff(0, () => 0)).toBe(500)
    expect(backoff(50, () => 1)).toBe(MAX_BACKOFF_MS)
  })

  it('goes offline on a drop and resumes each hub from its high-water seq', () => {
    const { feed, sockets, socket, clock } = fakeFeed(handlers())
    feed.track('a', 5)
    socket()?.open()
    socket()?.push({ type: 'changes', seq: 9, hubIds: ['a'], changes: [] })
    socket()?.drop()
    expect(feed.status.value).toBe('offline')
    expect(clock.pending()).toEqual([1000])

    // The first attempt fails; the next one waits twice as long.
    clock.advance(1000)
    expect(sockets).toHaveLength(2)
    expect(feed.status.value).toBe('offline')
    socket()?.drop()
    expect(clock.pending()).toEqual([2000])
    clock.advance(2000)
    expect(sockets).toHaveLength(3)
    socket()?.open()
    expect(feed.status.value).toBe('online')
    expect(socket()?.sent).toEqual([subscribe('a', 9)])

    // A successful connection resets the backoff.
    socket()?.drop()
    expect(clock.pending()).toEqual([1000])
  })

  it('subscribes a hub tracked while offline once it reconnects', () => {
    const { feed, socket, clock } = fakeFeed(handlers())
    feed.track('a', 5)
    socket()?.open()
    socket()?.drop()
    feed.track('b', 8)
    clock.advance(1000)
    socket()?.open()
    expect(socket()?.sent).toEqual([subscribe('a', 5), subscribe('b', 8)])
  })

  it('does not move a hub whose subscribe has not gone out', () => {
    const { feed, socket } = fakeFeed(handlers())
    feed.track('a', 5)
    socket()?.open()
    socket()?.drop()
    feed.track('b', 8)
    // A message from the old socket after the drop is not read.
    socket()?.push({ type: 'changes', seq: 50, hubIds: ['a', 'b'], changes: [] })
    expect(feed.position('b')).toBe(8)
  })
})

describe('feed client: server events', () => {
  const change: Change = { seq: 3, hubId: 'a', itemId: 'i1', item: null }

  it('passes changes on', () => {
    const h = handlers()
    const { feed, socket } = fakeFeed(h)
    feed.track('a', 1)
    socket()?.open()
    const message = {
      type: 'changes',
      seq: 3,
      hubIds: ['a'],
      changes: [change],
    } satisfies FeedServerMessage
    socket()?.push(message)
    expect(h.changes).toHaveBeenCalledWith(message)
  })

  it('ends the subscription on access_lost and resync', () => {
    const h = handlers()
    const { feed, socket } = fakeFeed(h)
    feed.track('a', 1)
    feed.track('b', 1)
    socket()?.open()
    socket()?.push({ type: 'access_lost', hubId: 'a' })
    socket()?.push({ type: 'resync', hubId: 'b' })
    expect(h.accessLost).toHaveBeenCalledWith('a')
    expect(h.resync).toHaveBeenCalledWith('b')
    expect(feed.isTracked('a')).toBe(false)
    expect(feed.isTracked('b')).toBe(false)
    // Tracking again after a resync subscribes from the new read.
    feed.track('b', 40)
    expect(socket()?.sent.at(-1)).toEqual(subscribe('b', 40))
  })

  it('treats a refused subscription as out of reach, like the server does for hidden hubs', () => {
    const h = handlers()
    const { feed, socket } = fakeFeed(h)
    feed.track('a', 1)
    feed.track('b', 1)
    socket()?.open()
    socket()?.push({ type: 'error', code: 'not_found', message: 'Hub not found', hubId: 'a' })
    socket()?.push({
      type: 'error',
      code: 'too_many_subscriptions',
      message: 'Too many',
      hubId: 'b',
    })
    expect(h.accessLost).toHaveBeenCalledWith('a')
    expect(h.refused).toHaveBeenCalledWith('b', 'too_many_subscriptions')
    expect(feed.isTracked('a')).toBe(false)
  })

  it('passes hub events on with their version', () => {
    const h = handlers()
    const { feed, socket } = fakeFeed(h)
    feed.track('a', 1)
    socket()?.open()
    socket()?.push({ type: 'hub', hubId: 'a', version: 4 })
    expect(h.hub).toHaveBeenCalledWith('a', 4)
  })
})

describe('feed client: letting go', () => {
  it('unsubscribes, and closes the socket a little after the last hub', () => {
    const { feed, socket, clock } = fakeFeed(handlers())
    feed.track('a', 1)
    socket()?.open()
    feed.untrack('a')
    expect(socket()?.sent.at(-1)).toEqual({ type: 'unsubscribe', hubId: 'a' })
    expect(socket()?.closed).toBe(false)
    clock.advance(LINGER_MS)
    expect(socket()?.closed).toBe(true)
    expect(feed.status.value).toBe('idle')
  })

  it('keeps the socket for a hub tracked again within the linger', () => {
    const { feed, sockets, socket, clock } = fakeFeed(handlers())
    feed.track('a', 1)
    socket()?.open()
    feed.untrack('a')
    feed.track('b', 2)
    clock.advance(LINGER_MS)
    expect(sockets).toHaveLength(1)
    expect(socket()?.closed).toBe(false)
    expect(socket()?.sent.at(-1)).toEqual(subscribe('b', 2))
  })

  it('stops reconnecting once nothing is tracked', () => {
    const { feed, sockets, socket, clock } = fakeFeed(handlers())
    feed.track('a', 1)
    socket()?.drop()
    feed.untrack('a')
    clock.advance(MAX_BACKOFF_MS)
    expect(sockets).toHaveLength(1)
    expect(feed.status.value).toBe('idle')
  })
})

describe('feed client: close codes (FEED_CLOSE_CODES)', () => {
  it('sends the reader to sign in on 4401 and does not reconnect', () => {
    const h = handlers()
    const { feed, sockets, socket, clock } = fakeFeed(h)
    feed.track('a', 1)
    socket()?.open()
    socket()?.drop(FEED_CLOSE_CODES.credentialsEnded)
    expect(h.credentialsEnded).toHaveBeenCalledTimes(1)
    expect(feed.status.value).toBe('stopped')
    clock.advance(MAX_BACKOFF_MS * 2)
    feed.track('b', 2)
    expect(sockets).toHaveLength(1)
  })

  it('stops on a frame too large, which a retry would repeat', () => {
    const h = handlers()
    const { feed, sockets, socket, clock } = fakeFeed(h)
    feed.track('a', 1)
    socket()?.open()
    socket()?.drop(FEED_CLOSE_CODES.frameTooLarge)
    expect(feed.status.value).toBe('stopped')
    expect(h.credentialsEnded).not.toHaveBeenCalled()
    clock.advance(MAX_BACKOFF_MS * 2)
    expect(sockets).toHaveLength(1)
  })

  it.each([
    FEED_CLOSE_CODES.goingAway,
    FEED_CLOSE_CODES.policy,
    FEED_CLOSE_CODES.internal,
    undefined,
  ])('reconnects with backoff and resumes after close code %s', (code) => {
    const { feed, sockets, socket, clock } = fakeFeed(handlers())
    feed.track('a', 1)
    socket()?.open()
    socket()?.push({ type: 'changes', seq: 6, hubIds: ['a'], changes: [] })
    socket()?.drop(code)
    expect(feed.status.value).toBe('offline')
    clock.advance(1000)
    expect(sockets).toHaveLength(2)
    socket()?.open()
    expect(socket()?.sent).toEqual([subscribe('a', 6)])
  })
})

describe('feed client: unanswered messages (MAX_PENDING_CLIENT_MESSAGES)', () => {
  it('never has more than the cap sent since the last message received', () => {
    const { feed, socket } = fakeFeed(handlers())
    feed.track('h0', 1)
    socket()?.open()
    // One subscribe is out; churn the rest so more than the cap would be sent in a row.
    for (let n = 0; n < MAX_PENDING_CLIENT_MESSAGES; n++) {
      feed.track(`x${String(n)}`, 1)
      feed.untrack(`x${String(n)}`)
    }
    feed.track('last', 3)
    expect(socket()?.sent).toHaveLength(MAX_PENDING_CLIENT_MESSAGES)
    // An answer makes room for the rest, in order.
    socket()?.push({ type: 'changes', seq: 1, hubIds: ['h0'], changes: [] })
    const sent = socket()?.sent ?? []
    expect(sent.length).toBeGreaterThan(MAX_PENDING_CLIENT_MESSAGES)
    expect(sent.at(-1)).toEqual(subscribe('last', 3))
  })

  it('drops a waiting subscribe for a hub let go before it could be sent', () => {
    const { feed, socket } = fakeFeed(handlers())
    feed.track('h0', 1)
    socket()?.open()
    for (let n = 1; n < MAX_PENDING_CLIENT_MESSAGES; n++) feed.track(`h${String(n)}`, 1)
    feed.track('late', 2)
    feed.untrack('late')
    socket()?.push({ type: 'changes', seq: 1, hubIds: ['h0'], changes: [] })
    const late = (socket()?.sent ?? []).filter((m) => m.hubId === 'late')
    expect(late).toEqual([{ type: 'unsubscribe', hubId: 'late' }])
  })
})
