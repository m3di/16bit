// @vitest-environment client-node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef, type Ref } from 'vue'
import { mount } from '../../test/fake-dom.ts'
import { useFillHeight } from './fill-height.ts'

// useFillHeight with the browser stubbed: a ResizeObserver that records what it watches,
// animation frames run by hand, and a page of plain objects (issue 232).

type El = {
  name: string
  parentElement: El | null
  previousElementSibling: El | null
  top: number
  paddingBottom: number
  getBoundingClientRect: () => { top: number }
}

function el(name: string, parent: El | null, previous: El | null = null, top = 0): El {
  const e: El = {
    name,
    parentElement: parent,
    previousElementSibling: previous,
    top,
    paddingBottom: 0,
    getBoundingClientRect: () => ({ top: e.top }),
  }
  return e
}

/** html > body > main (24px padding below) > heading, area. */
function page() {
  const html = el('html', null)
  const body = el('body', html)
  const main = el('main', body)
  main.paddingBottom = 24
  const heading = el('heading', main)
  const area = el('area', main, heading, 154)
  return { html, body, main, heading, area }
}

let observers: FakeObserver[] = []
class FakeObserver {
  watched = new Set<El>()
  observeCalls: El[] = []
  disconnected = false
  readonly callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
    observers.push(this)
  }
  observe(target: El) {
    this.observeCalls.push(target)
    this.watched.add(target)
  }
  unobserve(target: El) {
    this.watched.delete(target)
  }
  disconnect() {
    this.disconnected = true
    this.watched.clear()
  }
}

let frames = new Map<number, () => void>()
let nextFrame = 1
/** Runs the animation frames requested so far; returns how many ran. */
function runFrames() {
  const due = [...frames.values()]
  frames = new Map()
  for (const fn of due) fn()
  return due.length
}

const listeners = new Map<string, Set<() => void>>()
const win = {
  innerHeight: 900,
  scrollY: 0,
  addEventListener: (type: string, fn: () => void) => {
    let set = listeners.get(type)
    if (!set) listeners.set(type, (set = new Set()))
    set.add(fn)
  },
  removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
}

let current: ReturnType<typeof page>

beforeEach(() => {
  observers = []
  frames = new Map()
  listeners.clear()
  win.innerHeight = 900
  current = page()
  vi.stubGlobal('ResizeObserver', FakeObserver)
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    const id = nextFrame++
    frames.set(id, fn)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { documentElement: current.html })
  vi.stubGlobal('getComputedStyle', (e: El) => ({
    paddingBottom: `${String(e.paddingBottom)}px`,
    borderBottomWidth: '0px',
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function use(target: El) {
  let height: Ref<number | null> | undefined
  const Probe = defineComponent({
    setup() {
      height = useFillHeight(shallowRef(target) as unknown as Ref<HTMLElement | null>, 320)
      return () => h('div')
    },
  })
  const app = mount(Probe, {})
  const observer = observers[0]
  if (!height || !observer) throw new Error('not mounted')
  return { height, observer, unmount: app.unmount }
}

describe('useFillHeight', () => {
  it('measures on mount: the viewport below the element, less the padding under it', () => {
    const { height } = use(current.area)
    expect(height.value).toBe(900 - 154 - 24)
  })

  it('observes each element once, so an observation is never started over and never loops', () => {
    const { observer } = use(current.area)
    const first = observer.observeCalls.length
    expect([...observer.watched].map((e) => e.name).sort()).toEqual([
      'body',
      'heading',
      'html',
      'main',
    ])

    // Every observed element reports at once (as observe() does) and again on a resize.
    for (let i = 0; i < 3; i++) {
      observer.callback()
      expect(runFrames()).toBe(1)
    }
    expect(observer.observeCalls).toHaveLength(first)
    // Nothing new was observed, so no frame is pending: the measuring has stopped.
    expect(runFrames()).toBe(0)
  })

  it('measures at most once per frame, however many sizes change in it', () => {
    const { height, observer } = use(current.area)
    current.area.top = 200
    observer.callback()
    observer.callback()
    for (const fn of listeners.get('resize') ?? []) fn()
    expect(runFrames()).toBe(1)
    expect(height.value).toBe(900 - 200 - 24)
  })

  it('watches a notice that appears above, and lets it go when it is removed', () => {
    const { height, observer } = use(current.area)
    const notice = el('notice', current.main, current.heading)
    current.area.previousElementSibling = notice
    current.area.top = 210
    observer.callback()
    runFrames()
    expect(observer.watched.has(notice)).toBe(true)
    expect(height.value).toBe(900 - 210 - 24)

    current.area.previousElementSibling = current.heading
    current.area.top = 154
    observer.callback()
    runFrames()
    expect(observer.watched.has(notice)).toBe(false)
    expect(height.value).toBe(900 - 154 - 24)
  })

  it('never goes below the minimum', () => {
    win.innerHeight = 400
    const { height } = use(current.area)
    expect(height.value).toBe(320)
  })

  it('stops observing and listening on unmount, and drops a pending frame', () => {
    const { observer, unmount } = use(current.area)
    observer.callback()
    unmount()
    expect(observer.disconnected).toBe(true)
    expect(observer.watched.size).toBe(0)
    expect(listeners.get('resize')?.size ?? 0).toBe(0)
    expect(runFrames()).toBe(0)
  })
})
