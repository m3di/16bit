import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import DataTable from '../../ui/DataTable.vue'
import ItemPanel from '../../ui/ItemPanel.vue'
import type { Load } from '../home/useDashboard.ts'
import FolderSidebar from './FolderSidebar.vue'
import { description, item } from './fixtures.ts'
import ItemDetails from './ItemDetails.vue'
import ItemsBlock from './ItemsBlock.vue'
import NewItemForm from './NewItemForm.vue'
import { folderColumns, folderTree } from './useHub.ts'
import type { ItemList } from './useItems.ts'

const render = async (c: Component, props: Record<string, unknown> = {}, slot?: () => unknown) => {
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
  const app = createSSRApp({ render: () => h(c, props, slot ? { default: slot } : undefined) })
  app.use(router)
  await router.push('/w/w/hubs/bld')
  await router.isReady()
  return renderToString(app)
}

const columns = folderColumns(description, 'bld')
const ready = (ids: string[], nextCursor: string | null = null): Load<ItemList> => ({
  state: 'ready',
  data: { ids, nextCursor, more: false, moreError: null },
})

const block = (
  list: Load<ItemList>,
  rows = [item('i1', 12, { title: 'Ship', stage: 'done', points: 3 })],
) =>
  render(ItemsBlock, {
    folderName: 'Build',
    list,
    rows,
    columns,
    idPrefix: 'BLD',
    itemLink: (i: { id: string }) => ({ query: { item: i.id } }),
  })

describe('ItemsBlock', () => {
  it('shows one column per attribute after the ID, in position order', async () => {
    const html = await block(ready(['i1']))
    const headers = [...html.matchAll(/<th[^>]*>\s*([^<]*?)\s*<\/th>/g)].map((m) => m[1])
    expect(headers).toEqual(['ID', 'Title', 'Stage', 'Points'])
    expect(html).toContain('<caption')
    expect(html).toMatch(/<a [^>]*href="\/w\/w\/hubs\/bld\?item=i1"[^>]*>BLD-12<\/a>/)
    expect(html).toContain('Ship')
    expect(html).toContain('var(--pal-green-tint)')
    expect(html).toContain('Done')
  })

  it('offers more when there is a next page', async () => {
    expect(await block(ready(['i1'], 'c1'))).toContain('Load more')
    expect(await block(ready(['i1']))).not.toContain('Load more')
  })

  const states: [string, Load<ItemList>, string][] = [
    ['loading', { state: 'loading' }, 'role="status"'],
    ['empty', ready([]), 'No items in this folder yet'],
    ['error', { state: 'error', error: new ApiRequestError('internal', 'Boom', 500) }, 'Try again'],
    [
      'no permission',
      { state: 'error', error: new ApiRequestError('unauthorized', 'No', 401) },
      'You do not have access to this folder',
    ],
  ]
  it.each(states)('renders the %s state without a table', async (_name, list, expected) => {
    const html = await block(list, list.state === 'ready' ? [] : [item('i1', 1)])
    expect(html).toContain(expected)
    expect(html).not.toContain('<table')
  })

  it('offers "New item" in the empty state', async () => {
    expect(await block(ready([]), [])).toContain('New item')
  })
})

describe('FolderSidebar', () => {
  it('lists the hub and its folders, marks the open one, and indents children', async () => {
    const html = await render(FolderSidebar, {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(description) },
      folderId: 'a',
    })
    expect(html).toContain('aria-label="Folders"')
    expect(html.match(/data-folder-link/g)).toHaveLength(4)
    expect(html).toMatch(/href="\/w\/w\/hubs\/bld"/)
    const current = /<a [^>]*aria-current="page"[^>]*>/.exec(html)?.[0] ?? ''
    expect(current).toContain('href="/w/w/hubs/bld/a"')
    expect(html).toContain('padding-left:20px')
  })

  it('has a loading state', async () => {
    const html = await render(FolderSidebar, {
      workspaceId: 'w',
      hubName: null,
      tree: { state: 'loading' },
      folderId: 'bld',
    })
    expect(html).toContain('role="status"')
  })
})

describe('ItemDetails', () => {
  it('shows a labelled editor per field, the ID, and the version', async () => {
    const html = await render(ItemDetails, {
      item: item('abc-123', 4, { title: 'Ship', stage: 'todo', points: 3 }, 7),
      columns,
    })
    for (const label of ['Title (required)', 'Stage', 'Points']) {
      expect(html).toMatch(
        new RegExp(`<label for="[^"]+"[^>]*>${label.replace(/[()]/g, '\\$&')}</label>`),
      )
    }
    expect(html).toMatch(/data-item-id[^>]*>abc-123</)
    expect(html).toMatch(/data-item-version[^>]*>7</)
    expect(html).toContain('value="Ship"')
  })

  it('says when a folder has no fields', async () => {
    const html = await render(ItemDetails, { item: item('i', 1), columns: [] })
    expect(html).toContain('This folder has no fields yet.')
  })
})

describe('NewItemForm', () => {
  it('is a form with a submit button and the server field errors', async () => {
    const html = await render(NewItemForm, {
      columns,
      serverErrors: { title: 'A value is required' },
    })
    expect(html).toMatch(/^<form/)
    expect(html).toContain('type="submit"')
    expect(html).toContain('A value is required')
  })
})

describe('DataTable and ItemPanel', () => {
  it('marks the selected row', async () => {
    const html = await render(DataTable as Component, {
      caption: 'Things',
      columns: [{ key: 'id', label: 'ID' }],
      rows: [{ id: 'a' }, { id: 'b' }],
      selectedId: 'b',
    })
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  })

  it('is a labelled aside with a close button', async () => {
    const html = await render(ItemPanel, { title: 'BLD-4' }, () => 'Body')
    expect(html).toMatch(/^<aside aria-label="Item"/)
    expect(html).toContain('aria-label="Close panel"')
    expect(html).toContain('BLD-4')
    expect(html).toContain('Body')
  })
})
