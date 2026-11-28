import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import AppShell from './AppShell.vue'
import SettingsLayout from './SettingsLayout.vue'
import { inertOutside, type InertNode } from './sheet.ts'

// The layout rule (D85, DESIGN.md "Layout"): from `md` up the shell is the viewport's height and
// never scrolls; the top bar stays put and each pane scrolls on its own. Below `md` the page
// scrolls as one under a sticky top bar.

const render = async (
  c: Component,
  props: Record<string, unknown>,
  slots: Record<string, () => unknown>,
) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  const app = createSSRApp({ render: () => h(c, props, slots) })
  app.use(router)
  await router.push('/')
  await router.isReady()
  return renderToString(app)
}

/** The classes of the first element carrying `attr`. */
const classesOf = (html: string, attr: string) =>
  new RegExp(`<\\w+ class="([^"]*)"[^>]*${attr}`).exec(html)?.[1]?.split(' ') ?? []

const expectShell = (html: string) => {
  expect(classesOf(html, 'data-app-shell')).toEqual(
    expect.arrayContaining(['min-h-dvh', 'md:h-dvh', 'md:overflow-hidden']),
  )
  expect(classesOf(html, 'data-top-bar')).toEqual(
    expect.arrayContaining(['sticky', 'top-0', 'shrink-0', 'bg-bg']),
  )
}

describe('AppShell', () => {
  it('fixes the top bar and scrolls the sidebar and the content on their own', async () => {
    const html = await render(AppShell, {}, { sidebar: () => 'Folders', default: () => 'Main' })
    expectShell(html)
    expect(classesOf(html, 'data-sidebar-pane')).toEqual(
      expect.arrayContaining(['md:w-[208px]', 'md:overflow-y-auto']),
    )
    expect(classesOf(html, 'data-content-pane')).toEqual(
      expect.arrayContaining(['md:min-h-0', 'md:overflow-y-auto']),
    )
  })

  it('scrolls the content of a page without a sidebar too', async () => {
    const html = await render(AppShell, {}, { default: () => 'Main' })
    expectShell(html)
    expect(html).not.toContain('data-sidebar-pane')
    expect(classesOf(html, 'data-content-pane')).toContain('md:overflow-y-auto')
  })

  it('only clips the content when the page lays out its own panes', async () => {
    const html = await render(
      AppShell,
      { panes: true },
      { sidebar: () => 'Folders', default: () => 'Main' },
    )
    const content = classesOf(html, 'data-content-pane')
    expect(content).toContain('md:overflow-hidden')
    expect(content).not.toContain('md:overflow-y-auto')
  })
})

describe('SettingsLayout', () => {
  it('fixes the top bar and scrolls the content under it', async () => {
    const html = await render(
      SettingsLayout,
      {
        trail: ['Parcel Tracker'],
        back: { label: 'Back', to: '/' },
        navLabel: 'Hub settings',
        sections: [{ key: 'general', label: 'General', to: '/' }],
        current: 'general',
        title: 'Hub settings',
      },
      { default: () => 'Content' },
    )
    expectShell(html)
    expect(classesOf(html, 'data-content-pane')).toContain('md:overflow-y-auto')
    expect(/<nav[^>]*class="([^"]*)"/.exec(html)?.[1]).toContain('md:sticky')
  })
})

type Node = InertNode & { name: string; children: Node[]; parentElement: Node | null }

function tree(): Record<string, Node> {
  const make = (name: string, children: Node[] = []): Node => {
    const n: Node = { name, inert: false, parentElement: null, children }
    for (const c of children) c.parentElement = n
    return n
  }
  const panel = make('panel', [make('panel-child')])
  const table = make('table')
  const content = make('content', [table, panel])
  const sidebar = make('sidebar')
  const header = make('header')
  const shell = make('shell', [header, make('panes', [sidebar, content])])
  const popover = make('popover')
  const body = make('body', [shell, popover])
  const all: Record<string, Node> = {}
  const walk = (n: Node) => {
    all[n.name] = n
    n.children.forEach(walk)
  }
  walk(body)
  return all
}

/** The node of that name; fails the test when there is none. */
function at(nodes: Record<string, Node>, name: string): Node {
  const n = nodes[name]
  if (!n) throw new Error(`no node ${name}`)
  return n
}

describe('inertOutside', () => {
  it('makes everything outside the sheet inert, up to the body, and undoes it', () => {
    const n = tree()
    const undo = inertOutside(at(n, 'panel'), at(n, 'body'))
    const inert = Object.values(n)
      .filter((x) => x.inert)
      .map((x) => x.name)
    expect(inert.sort()).toEqual(['header', 'popover', 'sidebar', 'table'])
    undo()
    expect(Object.values(n).some((x) => x.inert)).toBe(false)
  })

  it('leaves alone what was inert already', () => {
    const n = tree()
    at(n, 'sidebar').inert = true
    inertOutside(at(n, 'panel'), at(n, 'body'))()
    expect(at(n, 'sidebar').inert).toBe(true)
  })
})
