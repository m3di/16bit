import type { Change, HubDescription } from '@16bit/core'
import { effectScope, nextTick, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import { createWorkspaceStore, type StoreEvents, type WorkspaceStore } from '../../sync/store.ts'
import { item } from '../hub/fixtures.test-utils.ts'
import {
  description,
  fakeSource,
  homeData,
  homeTree,
  ok,
  page,
  rawView,
  viewData,
  type FakeSource,
} from './fixtures.test-utils.ts'
import { createRequestQueue } from './queue.ts'
import { defaultViewSource, type ViewSource } from './source.ts'
import { REFRESH_DEBOUNCE, REFRESH_INTERVAL, useRootView } from './useRootView.ts'

type Listeners = { [K in keyof StoreEvents]: StoreEvents[K][] }

/** A store with no feed whose events the test sends, and `noteRead` and holds recorded. */
function testStore() {
  const base = createWorkspaceStore('w', null)
  const listeners: Listeners = { change: [], hub: [], accessLost: [], resync: [] }
  const noteRead = vi.fn()
  /** Hubs held now, once per hold. */
  const held: string[] = []
  const store: WorkspaceStore = {
    ...base,
    noteRead,
    hold: (hubId) => {
      held.push(hubId)
      let released = false
      return () => {
        if (released) return
        released = true
        held.splice(held.indexOf(hubId), 1)
      }
    },
    on: (event, fn) => {
      ;(listeners[event] as unknown[]).push(fn)
      return () => {
        const list = listeners[event] as unknown[]
        list.splice(list.indexOf(fn), 1)
      }
    },
  }
  const emit = {
    change: (change: Change) => {
      if (change.item) base.apply(change.item)
      for (const fn of listeners.change) fn(change)
    },
    hub: (hubId: string) => {
      for (const fn of listeners.hub) fn(hubId, 2)
    },
    resync: (hubId: string) => {
      for (const fn of listeners.resync) fn(hubId)
    },
  }
  return { store, emit, noteRead, listeners, held }
}

const START = Date.UTC(2026, 10, 23, 12, 0, 0)

function setup(
  folderId: string | null | (() => string | null),
  source: ViewSource,
  timeZone = 'Europe/Berlin',
  hub: HubDescription = description,
) {
  const t = testStore()
  const scope = effectScope()
  const view = scope.run(() =>
    useRootView({
      source,
      store: t.store,
      hubId: () => 'bld',
      folderId: typeof folderId === 'function' ? folderId : () => folderId,
      description: () => hub,
      queue: createRequestQueue(),
      timeZone,
    }),
  )
  if (!view) throw new Error('no scope')
  return {
    ...t,
    view,
    stop: () => {
      scope.stop()
    },
  }
}

const change = (id: string, folderId: string | null): Change => ({
  seq: 50,
  hubId: 'bld',
  itemId: id,
  item: folderId === null ? null : { ...item(id, 9), folderId, version: 2 },
})

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useRootView: which screen a folder gets', () => {
  it('shows today’s folder screen for a folder with no stored view, with no loading frame', () => {
    const { view, stop } = setup(
      'b',
      defaultViewSource(() => description),
    )
    expect(view.mode.value).toBe('default')
    stop()
  })

  it('shows "No view yet" for a views-only folder with none stored (D76)', () => {
    const { view, stop } = setup(
      'home',
      defaultViewSource(() => description),
    )
    expect(view.mode.value).toBe('none')
    stop()
  })

  it('waits for the hub before it asks for a view', async () => {
    const source = fakeSource([])
    const spy = vi.spyOn(source, 'view')
    const { view, stop } = setup(null, source)
    await settle()
    expect(view.mode.value).toBe('loading')
    expect(spy).not.toHaveBeenCalled()
    stop()
  })

  it('shows a view that could not be read as its error, keeping the request error', async () => {
    const source = fakeSource([])
    source.view = () =>
      Promise.reject(new ApiRequestError('forbidden', 'No access to this view.', 403))
    const { view, stop } = setup('home', source)
    await settle()
    expect(view.mode.value).toBe('error')
    expect(view.viewError.value?.isNoPermission).toBe(true)
    stop()
  })
})

describe('useRootView: a stored view and its data (D83)', () => {
  let source: FakeSource
  beforeEach(() => {
    source = fakeSource([rawView('home', homeTree)])
  })

  it('loads the view, then every data block in one request with its version and the zone', async () => {
    const { view, noteRead, store, stop } = setup('home', source)
    expect(view.mode.value).toBe('loading')
    await settle()
    expect(view.mode.value).toBe('view')
    expect(source.requests).toEqual([
      { folderId: 'home', request: { version: 3, tz: 'Europe/Berlin' } },
    ])
    expect(Object.keys(view.blocks.value).sort()).toEqual(
      ['backlog', 'day', 'in-sprint', 'open', 'sprint'].sort(),
    )
    expect(view.blocks.value['backlog']?.state).toBe('ready')
    // Follows the hub from the data's `seq`; the items it showed are in the store.
    expect(noteRead).toHaveBeenCalledWith('bld', 41)
    expect(store.get('i1')?.folderId).toBe('b')
    expect(view.problem.value).toBeNull()
    stop()
  })

  it('shows every data block loading until the data comes', async () => {
    let release: () => void = () => undefined
    source.answer(
      (_f, request) =>
        new Promise((resolve) => {
          release = () => {
            resolve(homeData(request.blocks))
          }
        }),
    )
    const { view, stop } = setup('home', source)
    await settle()
    expect(view.blocks.value['open']).toEqual({ state: 'loading' })
    release()
    await settle()
    expect(view.blocks.value['open']?.state).toBe('ready')
    stop()
  })

  it('reads again only the blocks a change touches, debounced', async () => {
    const { view, emit, stop } = setup('home', source)
    await settle()
    vi.advanceTimersByTime(REFRESH_INTERVAL)
    emit.change(change('i7', 'b'))
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE - 1)
    expect(source.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(source.requests).toHaveLength(2)
    // The Bugs folder backs the list and the number; the board reads the hub root and Sprints.
    expect(source.requests[1]?.request.blocks).toEqual(['backlog', 'open'])
    expect(view.blocks.value['backlog']?.state).toBe('ready')
    stop()
  })

  it('reads a `$block` dependant again when its item binding’s folder changes', async () => {
    const { emit, stop } = setup('home', source)
    await settle()
    vi.advanceTimersByTime(REFRESH_INTERVAL)
    emit.change(change('s9', 'sp'))
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(source.requests[1]?.request.blocks).toEqual(['sprint', 'day', 'in-sprint'])
    stop()
  })

  it('reads again at most once a second, however many changes come', async () => {
    const { emit, stop } = setup('home', source)
    await settle()
    // Straight after the first read: the next waits for a second to have passed.
    emit.change(change('i7', 'b'))
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(source.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL - REFRESH_DEBOUNCE)
    expect(source.requests).toHaveLength(2)
    for (let i = 0; i < 10; i++) {
      emit.change(change(`i${String(20 + i)}`, 'b'))
      await vi.advanceTimersByTimeAsync(100)
    }
    // A steady stream is not debounced forever.
    expect(source.requests).toHaveLength(3)
    stop()
  })

  it('reads every block again after a delete, whose folder the change does not carry', async () => {
    const { emit, stop } = setup('home', source)
    await settle()
    vi.advanceTimersByTime(REFRESH_INTERVAL)
    emit.change(change('gone', null))
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(source.requests[1]?.request.blocks).toBeUndefined()
    stop()
  })

  it('reads a block again when an item it shows moves to another folder', async () => {
    const { emit, stop } = setup('home', source)
    await settle()
    vi.advanceTimersByTime(REFRESH_INTERVAL)
    emit.change(change('i1', 'a'))
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(source.requests[1]?.request.blocks).toEqual(['backlog'])
    stop()
  })

  it('ignores changes in folders and hubs its blocks do not show', async () => {
    const { emit, stop } = setup('home', source)
    await settle()
    vi.advanceTimersByTime(REFRESH_INTERVAL)
    emit.change({ ...change('x', 'elsewhere'), hubId: 'other' })
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL)
    expect(source.requests).toHaveLength(1)
    stop()
  })

  it('reads the view again on a `hub` event, keeping it shown meanwhile', async () => {
    const { view, emit, stop } = setup('home', source)
    await settle()
    source.views = [rawView('home', homeTree, { version: 4 })]
    emit.hub('bld')
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(view.mode.value).toBe('view')
    expect(view.view.value?.version).toBe(4)
    // Its data waits for the once-a-second limit, as any refetch does.
    expect(source.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL)
    expect(source.requests.at(-1)?.request.version).toBe(4)
    stop()
  })

  it('reads the view once for a burst of `hub` events', async () => {
    const viewSpy = vi.spyOn(source, 'view')
    const { emit, stop } = setup('home', source)
    await settle()
    for (let i = 0; i < 5; i++) {
      emit.hub('bld')
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2)
    expect(viewSpy).toHaveBeenCalledTimes(2)
    expect(source.requests).toHaveLength(2)
    stop()
  })

  it('goes back to today’s folder screen when the view was reset', async () => {
    const bugs = fakeSource([rawView('b', homeTree)])
    const { view, emit, stop } = setup('b', bugs)
    await settle()
    expect(view.mode.value).toBe('view')
    // fakeSource answers the default for a folder it holds no view for.
    bugs.views = []
    emit.hub('bld')
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(view.mode.value).toBe('default')
    stop()
  })

  it('reads the view again when the data says the tree moved (409 stale)', async () => {
    source.answer(() => {
      source.views = [rawView('home', homeTree, { version: 5 })]
      source.answer((_f, request) => homeData(request.blocks))
      throw new ApiRequestError('stale', 'The view changed.', 409)
    })
    const viewSpy = vi.spyOn(source, 'view')
    const { view, stop } = setup('home', source)
    await settle()
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL)
    expect(viewSpy).toHaveBeenCalledTimes(2)
    expect(view.view.value?.version).toBe(5)
    expect(source.requests.at(-1)?.request.version).toBe(5)
    expect(view.blocks.value['open']?.state).toBe('ready')
    stop()
  })

  it('stops and says so when the data answers 409 forever, instead of looping', async () => {
    source.answer(() => {
      throw new ApiRequestError('stale', 'The view changed.', 409)
    })
    const viewSpy = vi.spyOn(source, 'view')
    const { view, stop } = setup('home', source)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(viewSpy.mock.calls.length).toBeLessThanOrEqual(2)
    expect(source.requests.length).toBeLessThanOrEqual(2)
    expect(view.problem.value).toBe('request')
    expect(view.blocks.value['open']).toEqual({ state: 'failed' })
    stop()
  })

  it('stops when the view comes back at the same version after a 403 from the data', async () => {
    source.answer(() => {
      throw new ApiRequestError('forbidden', 'No.', 403)
    })
    const viewSpy = vi.spyOn(source, 'view')
    const { view, stop } = setup('home', source)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(viewSpy).toHaveBeenCalledTimes(2)
    expect(source.requests).toHaveLength(1)
    expect(view.problem.value).toBe('request')
    stop()
  })

  it('says once for the page that the data failed, and "Try again" reads it again', async () => {
    source.answer(() => {
      throw new ApiRequestError('network', 'The server could not be reached.')
    })
    const { view, stop } = setup('home', source)
    await settle()
    expect(view.problem.value).toBe('request')
    expect(view.blocks.value['open']).toEqual({ state: 'failed' })
    source.answer((_f, request) => homeData(request.blocks))
    view.retry()
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL)
    expect(view.problem.value).toBeNull()
    expect(view.blocks.value['open']?.state).toBe('ready')
    stop()
  })

  it('says once for the page when blocks answer an error (the 5 s deadline)', async () => {
    source.answer(() =>
      viewData({
        ...homeData().blocks,
        open: { status: 'error', error: 'timeout' },
        day: { status: 'invalid', errors: [{ path: 'root', message: 'Removed' }] },
      }),
    )
    const { view, stop } = setup('home', source)
    await settle()
    expect(view.problem.value).toBe('blocks')
    stop()
  })

  it('treats a block the answer left out as an error, not as loading forever', async () => {
    source.answer(() => viewData({}))
    const { view, stop } = setup('home', source)
    await settle()
    expect(view.blocks.value['open']).toEqual({
      state: 'ready',
      status: { status: 'error', error: 'internal' },
    })
    stop()
  })

  it('reads blocks that use today again a second past midnight in the reader’s zone', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 23, 23, 59, 0))
    const { stop } = setup('home', source, 'UTC')
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(source.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000 + REFRESH_DEBOUNCE)
    expect(source.requests).toHaveLength(2)
    expect(source.requests[1]?.request.blocks).toEqual(['day'])
    stop()
  })

  it('reads everything again after a resync', async () => {
    const { emit, stop } = setup('home', source)
    await settle()
    vi.advanceTimersByTime(REFRESH_INTERVAL)
    emit.resync('bld')
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
    expect(source.requests).toHaveLength(2)
    expect(source.requests[1]?.request.blocks).toBeUndefined()
    stop()
  })

  it('stops listening and drops late answers once the page goes', async () => {
    const { listeners, stop } = setup('home', source)
    await settle()
    stop()
    expect(listeners.change).toHaveLength(0)
    expect(listeners.hub).toHaveLength(0)
    await nextTick()
  })
})

describe('useRootView: follow-ups', () => {
  it('does not hold a new folder’s first data back for the last folder’s once-a-second limit', async () => {
    const source = fakeSource([rawView('home', homeTree), rawView('sp', homeTree)])
    const open = shallowRef<string | null>('home')
    const { stop } = setup(() => open.value, source)
    await settle()
    expect(source.requests).toHaveLength(1)
    open.value = 'sp'
    await settle()
    expect(source.requests.map((r) => r.folderId)).toEqual(['home', 'sp'])
    stop()
  })

  it('remembers which folders it saw with a stored view', async () => {
    const source = fakeSource([rawView('home', homeTree)])
    const open = shallowRef<string | null>('home')
    const { view, stop } = setup(() => open.value, source)
    expect(view.knownStored('home')).toBe(false)
    await settle()
    expect(view.knownStored('home')).toBe(true)
    open.value = 'b'
    await settle()
    expect(view.knownStored('b')).toBe(false)
    // The view was reset: the next visit reads the folder's items alongside the view again.
    source.views = []
    open.value = 'home'
    await settle()
    expect(view.knownStored('home')).toBe(false)
    stop()
  })

  describe('a midnight slept through', () => {
    let doc: EventTarget & { visibilityState: string }
    beforeEach(() => {
      doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
      vi.stubGlobal('document', doc)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    const show = () => {
      doc.visibilityState = 'visible'
      doc.dispatchEvent(new Event('visibilitychange'))
    }

    it('reads the blocks that use today again when the page is shown on another day', async () => {
      vi.setSystemTime(Date.UTC(2026, 10, 23, 22, 0, 0))
      const source = fakeSource([rawView('home', homeTree)])
      const { stop } = setup('home', source, 'UTC')
      await settle()
      // The clock moves on while the machine sleeps; no timer has fired yet.
      vi.setSystemTime(Date.UTC(2026, 10, 24, 7, 0, 0))
      show()
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
      expect(source.requests).toHaveLength(2)
      expect(source.requests[1]?.request.blocks).toEqual(['day'])
      stop()
    })

    it('reads nothing again when the page is shown on the same day', async () => {
      const source = fakeSource([rawView('home', homeTree)])
      const { stop } = setup('home', source, 'UTC')
      await settle()
      vi.setSystemTime(START + 60 * 60_000)
      show()
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL)
      expect(source.requests).toHaveLength(1)
      stop()
    })
  })

  describe('a relation target in another hub', () => {
    const withTarget: HubDescription = {
      ...description,
      attributes: [
        ...description.attributes,
        {
          ...description.attributes[0],
          id: 'client',
          type: 'relation',
          config: { targetHubId: 'crm', crossHub: true, multiple: false },
        } as (typeof description.attributes)[number],
      ],
    }
    const clients = rawView(
      'sp',
      page([
        {
          id: 'by-client',
          type: 'list',
          config: {
            binding: { folderId: 'b', sort: [], limit: 50 },
            fields: [{ attribute: 'client' }],
            create: false,
          },
        },
      ]),
    )
    /** Hubs held beside the view's own. */
    const others = (held: string[]) => held.filter((h) => h !== 'bld')

    it('is followed from the data’s `seq` while a block shows it, and let go after', async () => {
      const s = fakeSource([rawView('home', homeTree), clients])
      s.answer((folderId, request) =>
        folderId === 'sp'
          ? viewData({ 'by-client': ok() }, { folderId })
          : homeData(request.blocks),
      )
      const open = shallowRef<string | null>('sp')
      const { held, noteRead, stop } = setup(() => open.value, s, 'UTC', withTarget)
      await settle()
      expect(others(held)).toEqual(['crm'])
      expect(noteRead).toHaveBeenCalledWith('crm', 41)
      // Home shows no relation from another hub.
      open.value = 'home'
      await settle()
      expect(others(held)).toEqual([])
      stop()
    })

    it('reads the labelling block again on a change or a resync there', async () => {
      const s = fakeSource([clients])
      s.answer((folderId) => viewData({ 'by-client': ok() }, { folderId }))
      const { emit, held, stop } = setup('sp', s, 'UTC', withTarget)
      await settle()
      vi.advanceTimersByTime(REFRESH_INTERVAL)
      emit.change({ seq: 60, hubId: 'crm', itemId: 'c1', item: null })
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
      expect(s.requests).toHaveLength(2)
      vi.advanceTimersByTime(REFRESH_INTERVAL)
      emit.resync('crm')
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE)
      expect(s.requests).toHaveLength(3)
      stop()
      expect(held).toEqual([])
    })
  })
})
