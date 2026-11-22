import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, effectScope, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ConnectionStatus from './ConnectionStatus.vue'
import { liveStore } from './fake-feed.test-utils.ts'
import { COUNTS_DELAY, useLiveHub } from './live.ts'
import type { FeedStatus } from './feed.ts'

const render = (status: FeedStatus) =>
  renderToString(createSSRApp({ render: () => h(ConnectionStatus, { status }) }))

describe('connection indicator', () => {
  it('says when live updates have stopped for good', async () => {
    const html = await render('stopped')
    expect(html).toContain('Offline')
    // Shown, not only read out: it does not fix itself like a drop does.
    expect(html).toMatch(
      /<span[^>]*data-connection-stopped[^>]*>Live updates stopped\. Reload the page/,
    )
    expect(html).not.toContain('sr-only')
  })

  it('says Offline, in words, only while the connection is down', async () => {
    const offline = await render('offline')
    expect(offline).toContain('role="status"')
    expect(offline).toContain('Offline')
    expect(offline).toContain('Live updates are paused')
    for (const status of ['idle', 'connecting', 'online'] as const) {
      const html = await render(status)
      // The live region stays, empty, so going offline is announced.
      expect(html).toContain('role="status"')
      expect(html).not.toContain('Offline')
    }
  })
})

describe('feed events for a page', () => {
  it('runs the schema reload for its own hub, and turns lost on access_lost', () => {
    const { store, socket } = liveStore()
    store.hold('bld')
    store.noteRead('bld', 1)
    socket()?.open()
    const onSchema = vi.fn()
    const scope = effectScope()
    const live = scope.run(() => useLiveHub(store, () => 'bld', onSchema))
    socket()?.push({ type: 'hub', hubId: 'other', version: 9 })
    // Always read again: folder and attribute writes leave the hub's version alone.
    socket()?.push({ type: 'hub', hubId: 'bld', version: 0 })
    expect(onSchema).toHaveBeenCalledTimes(1)
    expect(onSchema).toHaveBeenCalledWith('bld')
    expect(live?.lost.value).toBe(false)
    socket()?.push({ type: 'access_lost', hubId: 'bld' })
    expect(live?.lost.value).toBe(true)
    scope.stop()
    socket()?.push({ type: 'hub', hubId: 'bld', version: 5 })
    expect(onSchema).toHaveBeenCalledTimes(1)
  })
})

describe('folder counts after item changes', () => {
  const gone = (hubId: string, seq: number) => ({
    seq,
    hubId,
    itemId: `i${String(seq)}`,
    item: null,
  })

  it('reads the counts once per burst of changes in its hub, one read at a time', async () => {
    vi.useFakeTimers()
    try {
      const { store } = liveStore()
      let finish: () => void = () => undefined
      const onCounts = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const scope = effectScope()
      scope.run(() => useLiveHub(store, () => 'bld', vi.fn(), onCounts))

      store.receive([gone('other', 1)])
      await vi.advanceTimersByTimeAsync(COUNTS_DELAY)
      expect(onCounts).not.toHaveBeenCalled()

      store.receive([gone('bld', 2), gone('bld', 3)])
      store.receive([gone('bld', 4)])
      await vi.advanceTimersByTimeAsync(COUNTS_DELAY - 1)
      expect(onCounts).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onCounts).toHaveBeenCalledTimes(1)
      expect(onCounts).toHaveBeenCalledWith('bld')

      // A change while the read runs waits for it, then reads again.
      store.receive([gone('bld', 5)])
      await vi.advanceTimersByTimeAsync(COUNTS_DELAY * 4)
      expect(onCounts).toHaveBeenCalledTimes(1)
      finish()
      await vi.advanceTimersByTimeAsync(COUNTS_DELAY)
      expect(onCounts).toHaveBeenCalledTimes(2)
      finish()

      // Nothing after the page is gone.
      store.receive([gone('bld', 6)])
      scope.stop()
      await vi.advanceTimersByTimeAsync(COUNTS_DELAY)
      expect(onCounts).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
