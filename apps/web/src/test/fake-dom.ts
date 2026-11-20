import { createRenderer, h, type Component } from 'vue'

// Mounts a component without a DOM, for tests that need its event handlers to run. Nodes are
// plain objects; an element's props and listeners both receive the events fired at it, as in a
// browser. Use with `// @vitest-environment client-node` so components have client render
// functions (test/client-environment.ts).

export type FakeNode = {
  tag: string
  props: Record<string, unknown>
  children: FakeNode[]
  parent: FakeNode | null
  text: string
  value: string
  listeners: Record<string, ((e: unknown) => void)[]>
  addEventListener: (type: string, fn: (e: unknown) => void) => void
  removeEventListener: (type: string, fn: (e: unknown) => void) => void
  getRootNode: () => FakeNode
  /** Records focus on the root, as `document.activeElement` would. */
  focus: () => void
  /** Scrolling has no layout here; it records the offset asked for. */
  scrollTop: number
  scrollTo: (options: { top?: number }) => void
}

const focused = new WeakMap<FakeNode, FakeNode>()

/** The element last focused under a mounted root, like `document.activeElement`. */
export const activeElement = (root: FakeNode) => focused.get(root)

function node(tag: string, text = ''): FakeNode {
  const n: FakeNode = {
    tag,
    props: {},
    children: [],
    parent: null,
    text,
    value: '',
    listeners: {},
    addEventListener: (type, fn) => {
      ;(n.listeners[type] ??= []).push(fn)
    },
    removeEventListener: (type, fn) => {
      n.listeners[type] = (n.listeners[type] ?? []).filter((f) => f !== fn)
    },
    getRootNode: () => {
      let top = n
      while (top.parent) top = top.parent
      return top
    },
    focus: () => {
      focused.set(n.getRootNode(), n)
    },
    scrollTop: 0,
    scrollTo: ({ top }) => {
      if (top !== undefined) n.scrollTop = top
    },
  }
  return n
}

const { createApp } = createRenderer<FakeNode, FakeNode>({
  createElement: (tag) => node(tag),
  createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text),
  setText: (n, text) => {
    n.text = text
  },
  setElementText: (n, text) => {
    n.children = [node('#text', text)]
  },
  insert: (child, parent, anchor) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at < 0) parent.children.push(child)
    else parent.children.splice(at, 0, child)
  },
  remove: (child) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  },
  parentNode: (n) => n.parent,
  nextSibling: (n) => {
    const siblings = n.parent?.children ?? []
    return siblings[siblings.indexOf(n) + 1] ?? null
  },
  patchProp: (n, key, _prev, next) => {
    n.props[key] = next
    if (key === 'value') n.value = next === null || next === undefined ? '' : String(next)
  },
})

/** Every element under `n` (itself included) that `match` accepts, in document order. */
export const findAll = (n: FakeNode, match: (n: FakeNode) => boolean): FakeNode[] => [
  ...(match(n) ? [n] : []),
  ...n.children.flatMap((c) => findAll(c, match)),
]

const find = (n: FakeNode, tag: string): FakeNode | undefined =>
  n.tag === tag ? n : n.children.map((c) => find(c, tag)).find(Boolean)

/** Fires a DOM-like event at an element: its `on<Type>` prop, then its listeners. */
export function fire(el: FakeNode, type: string, init: Record<string, unknown> = {}) {
  const event = { type, target: el, ...init }
  const prop = el.props[`on${type.charAt(0).toUpperCase()}${type.slice(1)}`]
  if (typeof prop === 'function') (prop as (e: unknown) => void)(event)
  for (const fn of el.listeners[type] ?? []) fn(event)
}

/** Types into an input: sets its value and fires `input`. */
export function type(el: FakeNode, value: string, init: Record<string, unknown> = {}) {
  el.value = value
  fire(el, 'input', init)
}

export function mount(component: Component, props: Record<string, unknown>) {
  const root = node('root')
  createApp({ render: () => h(component, props) }).mount(root)
  return {
    root,
    /** The first element with this tag; throws when there is none. */
    get: (tag: string) => {
      const found = find(root, tag)
      if (!found) throw new Error(`no <${tag}> rendered`)
      return found
    },
  }
}
