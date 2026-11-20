import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, effectScope, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ConnectionStatus from './ConnectionStatus.vue'
import { liveStore } from './fake-feed.test-utils.ts'
import { hubEventIsNew, useLiveHub } from './live.ts'
import type { FeedStatus } from './feed.ts'

const render = (status: FeedStatus) =>
  renderToString(createSSRApp({ render: () => h(ConnectionStatus, { status }) }))

describe('connection indicator', () => {
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
  it('reads a schema again unless the event is older than what is shown', () => {
    expect(hubEventIsNew(3, 4)).toBe(true)
    expect(hubEventIsNew(3, 3)).toBe(true)
    expect(hubEventIsNew(3, 2)).toBe(false)
  })

  it('runs the schema reload for its own hub, and turns lost on access_lost', () => {
    const { store, socket } = liveStore()
    store.hold('bld')
    store.noteRead('bld', 1)
    socket()?.open()
    const onSchema = vi.fn()
    const scope = effectScope()
    const live = scope.run(() => useLiveHub(store, () => 'bld', onSchema))
    socket()?.push({ type: 'hub', hubId: 'other', version: 9 })
    socket()?.push({ type: 'hub', hubId: 'bld', version: 4 })
    expect(onSchema).toHaveBeenCalledTimes(1)
    expect(onSchema).toHaveBeenCalledWith('bld', 4)
    expect(live?.lost.value).toBe(false)
    socket()?.push({ type: 'access_lost', hubId: 'bld' })
    expect(live?.lost.value).toBe(true)
    scope.stop()
    socket()?.push({ type: 'hub', hubId: 'bld', version: 5 })
    expect(onSchema).toHaveBeenCalledTimes(1)
  })
})
