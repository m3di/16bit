import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import FolderSidebar from '../hub/FolderSidebar.vue'
import { folderTree } from '../hub/useHub.ts'
import { folderLink } from '../item/item-page.ts'
import { description, homeData, homeTree, page } from './fixtures.test-utils.ts'
import { readTree } from './render-tree.ts'
import type { BlockLoad, DataProblem } from './useRootView.ts'
import ViewRenderer from './ViewRenderer.vue'

const render = async (c: Component, props: Record<string, unknown>) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/w/:workspaceId/hubs/:hubId/:folderId?',
        name: 'hub',
        component: { render: () => null },
      },
    ],
  })
  const app = createSSRApp({ render: () => h(c, props) })
  app.use(router)
  await router.push('/w/w/hubs/bld')
  await router.isReady()
  return renderToString(app)
}

const ready = (only?: string[]): Record<string, BlockLoad> =>
  Object.fromEntries(
    Object.entries(homeData(only).blocks).map(([id, status]) => [id, { state: 'ready', status }]),
  )

const view = (
  tree: unknown = homeTree,
  blocks: Record<string, BlockLoad> = ready(),
  more: { problem?: DataProblem; live?: string | null } = {},
) =>
  render(ViewRenderer, {
    page: readTree(tree).page,
    folderName: 'Home folder',
    live: more.live === undefined ? 'online' : more.live,
    blocks,
    problem: more.problem ?? null,
    nameOf: (b: { id: string }) => `Name of ${b.id}`,
  })

const headings = (html: string) =>
  [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map(
    (m) => `h${m[1] ?? ''} ${(m[2] ?? '').replace(/<[^>]*>/g, '').trim()}`,
  )

describe('ViewRenderer', () => {
  it('opens on the page title with the live dot, then each block in order', async () => {
    const html = await view()
    expect(html).toContain('data-block="page-header"')
    expect(html).toContain('Live')
    expect(headings(html)[0]).toBe('h1 Home')
    expect(html.indexOf('What the team is on.')).toBeLessThan(html.indexOf('This week'))
    expect(html).toContain('data-block="columns"')
  })

  it('uses the folder’s name when the page has no title', async () => {
    const html = await view(page([{ id: 't', type: 'text', config: { text: 'Hi' } }]))
    expect(headings(html)[0]).toBe('h1 Home folder')
  })

  it('keeps one h1 and never skips a level, wrapping lists and boards outside a section', async () => {
    const html = await view()
    expect(headings(html)).toEqual([
      'h1 Home',
      // A configured level 1 heading under the page is an h2.
      'h2 This week',
      'h2 Backlog',
      // Level 3 inside a titled section stays an h3.
      'h3 Next up',
      // The board sits right under the page: it gets an h2, named for screen readers only.
      'h2 Name of in-sprint',
    ])
    expect(html).toMatch(/<h2[^>]*class="sr-only"[^>]*>Name of in-sprint<\/h2>/)
    // The list is already in a titled section, so it gets no extra heading.
    expect(html).not.toContain('Name of backlog')
  })

  it('starts headings under a nested titled section at h3, since its heading is an h2', async () => {
    const html = await view(
      page([
        {
          id: 'outer',
          type: 'section',
          config: { title: 'Outer' },
          children: [
            {
              id: 'cols',
              type: 'columns',
              config: {},
              children: [
                {
                  id: 'inner',
                  type: 'section',
                  config: { title: 'Inner' },
                  children: [
                    { id: 'deep', type: 'heading', config: { text: 'Deep', level: 3 } },
                    { id: 'l', type: 'list', config: { binding: { folderId: 'b' } } },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    )
    expect(headings(html)).toEqual(['h1 Home folder', 'h2 Outer', 'h2 Inner', 'h3 Deep'])
    // The list inside is under a titled section: no extra heading for it.
    expect(html).not.toContain('Name of l')
  })

  it('keeps line breaks in text and shows no markup from it', async () => {
    const html = await view(
      page([{ id: 't', type: 'text', config: { text: '<b>bold</b>\nnext' } }]),
    )
    expect(html).toContain('whitespace-pre-line')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('shows each data block’s own state, and the rest of the page around it', async () => {
    const html = await view(homeTree, {
      ...ready(),
      open: { state: 'loading' },
      day: { state: 'ready', status: { status: 'unresolved', blocks: ['sprint'] } },
      sprint: { state: 'ready', status: { status: 'not_found' } },
      backlog: { state: 'ready', status: { status: 'invalid', errors: [] } },
    })
    expect(html).toMatch(/data-view-block="open" data-block-state="loading"/)
    expect(html).toContain('Nothing to show yet')
    expect(html).toContain('This item is not available')
    expect(html).toContain('This block needs fixing')
    expect(html).toContain('What the team is on.')
    // None of these is an alert: nothing failed.
    expect(html).not.toContain('role="alert"')
  })

  it('announces a failed load once for the page, not once per block', async () => {
    const failed: Record<string, BlockLoad> = Object.fromEntries(
      ['sprint', 'backlog', 'open', 'day', 'in-sprint'].map((id) => [id, { state: 'failed' }]),
    )
    const html = await view(homeTree, failed, { problem: 'request' })
    expect(html.match(/role="alert"/g)).toHaveLength(1)
    expect(html).toContain('The data for this view could not be loaded.')
    expect(html).toContain('Try again')
    expect(html.match(/This block could not load/g)).toHaveLength(5)
  })

  it('says when some blocks answered an error (the request deadline)', async () => {
    const html = await view(
      homeTree,
      { ...ready(), open: { state: 'ready', status: { status: 'error', error: 'timeout' } } },
      { problem: 'blocks' },
    )
    expect(html.match(/role="alert"/g)).toHaveLength(1)
    expect(html).toContain('Some blocks could not be loaded.')
  })

  it('shows a block it cannot read as a compact error, and keeps the rest', async () => {
    const html = await view(
      page([
        { id: 'a', type: 'text', config: { text: 'Before' } },
        { id: 'b', type: 'timeline', config: {} } as never,
        { id: 'c', type: 'text', config: { text: 'After' } },
      ]),
    )
    expect(html).toContain('Before')
    expect(html).toContain('After')
    expect(html).toMatch(
      /data-view-block="b"[^>]*data-block-broken|data-block-broken[^>]*data-view-block="b"/,
    )
    expect(html).toContain('This block could not be shown')
  })

  it('designs an empty page and a tree it cannot read at all', async () => {
    expect(await view(page([]))).toContain('This view has no blocks yet')
    expect(await view({ nope: true })).toContain('This view could not be read')
  })

  it('shows no live dot when the page does not follow the feed', async () => {
    const html = await view(homeTree, ready(), { live: null })
    expect(html).not.toContain('data-live')
  })
})

describe('views-only folders and "Opens on" in the sidebar (D76)', () => {
  const sidebar = () =>
    render(FolderSidebar, {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(description) },
      folderId: 'home',
      opensOnFolderId: description.hub.opensOnFolderId,
    })

  it('shows "Views only" in place of a views-only folder’s count', async () => {
    const html = await sidebar()
    const home = html.slice(html.indexOf('>Home<'))
    expect(home.slice(0, 400)).toContain('Views only')
    expect(html.match(/Views only/g)).toHaveLength(1)
  })

  it('links the hub root by name when the hub opens on another folder', async () => {
    const html = await sidebar()
    expect(html).toContain('href="/w/w/hubs/bld/bld"')
    expect(html).toContain('href="/w/w/hubs/bld/home"')
  })

  it('keeps the hub root’s plain link when the hub opens on its root', async () => {
    const html = await render(FolderSidebar, {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(description) },
      folderId: 'home',
    })
    expect(html).toContain('href="/w/w/hubs/bld"')
    expect(html).not.toContain('href="/w/w/hubs/bld/bld"')
  })

  it('names the hub root in an item’s folder link only when the hub opens elsewhere', () => {
    const inRoot = { hubId: 'bld', folderId: 'bld' }
    expect(folderLink('w', inRoot)).toEqual({
      name: 'hub',
      params: { workspaceId: 'w', hubId: 'bld' },
    })
    expect(folderLink('w', inRoot, 'home')).toEqual({
      name: 'hub',
      params: { workspaceId: 'w', hubId: 'bld', folderId: 'bld' },
    })
  })
})
