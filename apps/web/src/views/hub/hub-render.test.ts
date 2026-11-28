import type { Folder, Item } from '@16bit/core'
import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import DataTable from '../../ui/DataTable.vue'
import ItemPanel from '../../ui/ItemPanel.vue'
import type { Load } from '../home/useDashboard.ts'
import FolderSidebar from './FolderSidebar.vue'
import HubState from './HubState.vue'
import { description, item } from './fixtures.test-utils.ts'
import ItemDetails from './ItemDetails.vue'
import ItemPanelBody from './ItemPanelBody.vue'
import ItemsBlock from './ItemsBlock.vue'
import NewItemForm from './NewItemForm.vue'
import { folderActions } from '../hub-settings/schema.ts'
import { folderColumns, folderTree } from './useHub.ts'
import type { ItemList, SortKey } from './useItems.ts'

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
const ready = (total: number, more: Partial<ItemList> = {}): Load<ItemList> => ({
  state: 'ready',
  data: { total, sort: null, where: null, sorting: false, failed: [], failure: null, ...more },
})

const block = (
  list: Load<ItemList>,
  rows: Item[] = [item('i1', 12, { title: 'Ship', stage: 'done', points: 3 })],
  readOnly = false,
  sort: SortKey | null = null,
) =>
  render(ItemsBlock, {
    folderName: 'Build',
    list,
    rowAt: (i: number) => rows[i],
    indexOf: (id: string) => rows.findIndex((r) => r.id === id),
    columns,
    idPrefix: 'BLD',
    itemLink: (i: { id: string }) => ({ query: { item: i.id } }),
    readOnly,
    sort,
  })

/** Each header's text, without markup. */
const headerTexts = (html: string) =>
  [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    (m[1] ?? '').replace(/<[^>]*>/g, '').trim(),
  )
const header = (html: string, label: string) =>
  [...html.matchAll(/<th[^>]*>[\s\S]*?<\/th>/g)]
    .map((m) => m[0])
    .find((th) =>
      th
        .replace(/<[^>]*>/g, '')
        .trim()
        .startsWith(label),
    ) ?? ''

describe('ItemsBlock', () => {
  it('shows one column per attribute after the ID, in position order', async () => {
    const html = await block(ready(1))
    expect(headerTexts(html)).toEqual(['ID', 'Title', 'Stage', 'Points'])
    expect(html).toContain('<caption')
    expect(html).toMatch(/<a [^>]*href="\/w\/w\/hubs\/bld\?item=i1"[^>]*>BLD-12<\/a>/)
    expect(html).toContain('Ship')
    expect(html).toContain('var(--pal-green-tint)')
    expect(html).toContain('Done')
  })

  it('makes headers of indexed, sortable attributes sort buttons', async () => {
    const html = await block(ready(1))
    // Stage is indexed; Title and Points are not, and the ID column has no attribute.
    expect(header(html, 'Stage')).toMatch(/<button type="button"[^>]*>(\s|<!---->)*Stage/)
    expect(header(html, 'Stage')).toContain('data-sort="none"')
    expect(header(html, 'Stage')).not.toContain('aria-sort')
    for (const label of ['ID', 'Title', 'Points']) {
      expect(header(html, label)).not.toContain('<button')
    }
    expect(html).toContain('column headers with buttons are sortable')
  })

  it('marks the sorted column with aria-sort and an arrow', async () => {
    const asc = await block(ready(1), undefined, false, {
      attribute: 'stage',
      direction: 'asc',
    })
    expect(header(asc, 'Stage')).toContain('aria-sort="ascending"')
    expect(header(asc, 'Stage')).toContain('data-sort-icon="ascending"')
    const desc = await block(ready(1), undefined, false, {
      attribute: 'stage',
      direction: 'desc',
    })
    expect(header(desc, 'Stage')).toContain('aria-sort="descending"')
    expect(header(desc, 'Stage')).toContain('data-sort-icon="descending"')
  })

  it('keeps the rows while a new order loads', async () => {
    const html = await block(ready(1, { sorting: true }))
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Ship')
    expect(html).toContain('Sorting…')
  })

  it('is a virtual table sized by the total, with placeholders for rows not loaded (D61)', async () => {
    const html = await block(ready(50_000))
    expect(html).toContain('data-mode="virtual"')
    expect(html).toMatch(/<table[^>]*aria-rowcount="50001"/)
    expect(html).toContain('Ship')
    expect(html).toContain('data-placeholder')
    expect(html).not.toContain('Load more')
    // The ID column is narrow and fixed; columns do not jump while scrolling.
    expect(html).toMatch(/<th[^>]*style="width:104px;"[^>]*>(<!--\[-->)?ID/)
  })

  it('says which rows could not be loaded, with a retry', async () => {
    const html = await block(
      ready(50_000, { failed: [200], failure: new ApiRequestError('internal', 'Down.', 500) }),
    )
    expect(html).toMatch(/role="alert"[^>]*>Rows 201 to 400 could not be loaded\. Down\./)
    expect(html).toMatch(/<button[^>]*>(<!--\[-->)?Try again(<!--\]-->)?<\/button>/)
  })

  const states: [string, Load<ItemList>, string][] = [
    ['loading', { state: 'loading' }, 'role="status"'],
    ['empty', ready(0), 'No items in this folder yet'],
    ['error', { state: 'error', error: new ApiRequestError('internal', 'Boom', 500) }, 'Try again'],
    [
      'no permission',
      { state: 'error', error: new ApiRequestError('unauthorized', 'No', 401) },
      'You do not have access to this folder',
    ],
    [
      'forbidden',
      { state: 'error', error: new ApiRequestError('forbidden', 'No', 403) },
      'You do not have access to this folder',
    ],
    [
      'not found',
      { state: 'error', error: new ApiRequestError('not_found', 'Gone', 404) },
      'This folder is not available',
    ],
  ]
  it.each(states)('renders the %s state without a table', async (_name, list, expected) => {
    const html = await block(list, list.state === 'ready' ? [] : [item('i1', 1)])
    expect(html).toContain(expected)
    expect(html).not.toContain('<table')
  })

  it('offers "New item" in the empty state', async () => {
    expect(await block(ready(0), [])).toContain('New item')
  })

  it('offers no "New item" once the hub is read-only, and leaves the reason to the page', async () => {
    const html = await block(ready(0), [], true)
    expect(html).toContain('No items in this folder yet')
    expect(html).not.toContain('New item')
    // HubPage's header states the read-only reason once; the empty state does not repeat it.
    expect(html).not.toContain('You can view the items')
    expect(html).not.toContain('Items you add here')
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

  it('shows the root as the hub, read as its own items, with its own count, and nests the folders', async () => {
    const product = {
      ...description,
      hub: { ...description.hub, itemCount: 1200 },
      folders: description.folders.map((f) => ({ ...f, itemCount: 300 })),
    }
    const html = await render(FolderSidebar, {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(product) },
      folderId: 'bld',
    })
    const root = /<a [^>]*data-folder-root[^>]*>.*?<\/a>/s.exec(html)?.[0] ?? ''
    expect(root).toContain('href="/w/w/hubs/bld"')
    expect(root).toContain('aria-current="page"')
    expect(root).toContain('aria-label="Build, items in the hub itself, 300 items"')
    expect(root).not.toContain('Items in')
    expect(root).toMatch(/>Build</)
    expect(root).toMatch(/aria-label="300 items"[^>]*>300</)
    // Every other folder is in a list inside the root's entry, under a hairline guide.
    const nested = /data-folder-root[^>]*>.*?<\/a>.*?<ul [^>]*border-l[^>]*>(.*?)<\/ul>/s.exec(
      html,
    )?.[1]
    expect(nested?.match(/data-folder-link/g)).toHaveLength(3)
    expect(html.match(/aria-label="300 items"/g)).toHaveLength(4)
  })

  it('offers a folder menu beside each link only when given actions', async () => {
    const props = {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(description) },
      folderId: 'bld',
    }
    const without = await render(FolderSidebar, props)
    expect(without).not.toContain('aria-haspopup="menu"')
    expect(without).not.toContain('data-folder-actions')

    const html = await render(FolderSidebar, {
      ...props,
      actionsFor: (f: Folder) => folderActions(description, f),
    })
    for (const name of ['Build', 'Bugs', 'Archive', 'Old']) {
      expect(html).toContain(`aria-label="Actions for ${name}"`)
    }
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(4)
    // Outside the link, so opening the menu never navigates.
    for (const link of html.match(/<a [^>]*>.*?<\/a>/gs) ?? []) {
      expect(link).not.toContain('<button')
    }
    // Shown on hover and focus, and always on touch screens and at phone width.
    const wrapper = /<span [^>]*data-folder-actions[^>]*>/.exec(html)?.[0] ?? ''
    for (const cls of [
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus-within:opacity-100',
      'pointer-coarse:opacity-100',
      'max-sm:opacity-100',
    ]) {
      expect(wrapper.split(/[\s"]/)).toContain(cls)
    }
  })

  it('shows a count only for a folder with items: an empty folder and an empty root show nothing', async () => {
    const empty = {
      ...description,
      hub: { ...description.hub, itemCount: 2 },
      folders: description.folders.map((f, i) => ({ ...f, itemCount: i === 0 ? 2 : 0 })),
    }
    const html = await render(FolderSidebar, {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(empty) },
      folderId: 'bld',
    })
    const root = /<a [^>]*data-folder-root[^>]*>.*?<\/a>/s.exec(html)?.[0] ?? ''
    expect(root).toContain('aria-label="Build, items in the hub itself"')
    expect(root).not.toContain('data-folder-count')
    expect(html.match(/data-folder-count/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="2 items"[^>]*>2</)
    expect(html).not.toMatch(/>0</)
  })

  it('leaves the root count out when it cannot be told', async () => {
    const cut = { ...description, truncated: { ...description.truncated, folders: true } }
    const html = await render(FolderSidebar, {
      workspaceId: 'w',
      hubName: 'Build',
      tree: { state: 'ready', data: folderTree(cut) },
      folderId: 'bld',
    })
    const root = /<a [^>]*data-folder-root[^>]*>.*?<\/a>/s.exec(html)?.[0] ?? ''
    expect(root).toContain('aria-label="Build, items in the hub itself"')
    expect(root).not.toContain('data-folder-count')
    expect(html.match(/data-folder-count/g)).toHaveLength(3)
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

  it('shows the external key beside the ID only when the item has one (D64)', async () => {
    expect(await render(ItemDetails, { item: item('i', 1), columns })).not.toContain(
      'data-external-key',
    )
    const html = await render(ItemDetails, {
      item: { ...item('i', 1), externalKey: 'ticket 42' },
      columns,
    })
    expect(html).toMatch(/data-item-id[^>]*>i<\/dd>(<!--\[-->)?<dt[^>]*>External key<\/dt>/)
    expect(html).toMatch(/data-external-key>ticket 42</)
  })

  it('disables the editors while the item is not confirmed', async () => {
    const html = await render(ItemDetails, { item: item('i', 1), columns, disabled: true })
    expect(html.match(/<(input|select)[^>]* disabled/g)).toHaveLength(columns.length)
  })

  it('labels the details section with a generated heading ID', async () => {
    const html = await render(ItemDetails, { item: item('i', 1), columns })
    const id = /<h3 id="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`aria-labelledby="${id ?? ''}"`)
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

  it('is a pane from lg up and a full-screen sheet below it, scrolling on its own (D85)', async () => {
    const html = await render(ItemPanel, { title: 'BLD-4' }, () => 'Body')
    // One root, so a screen's class reaches the aside.
    expect(html).toMatch(/^<aside[^>]*>[\s\S]*<\/aside>$/)
    const aside = /^<aside[^>]*? class="([^"]*)"/.exec(html)?.[1]?.split(' ') ?? []
    expect(aside).toEqual(
      expect.arrayContaining(['lg:[contain:size]', 'max-lg:fixed', 'max-lg:inset-0', 'bg-bg']),
    )
    const scroll = /<div class="([^"]*)" data-item-panel-scroll/.exec(html)?.[1]?.split(' ') ?? []
    expect(scroll).toEqual(
      expect.arrayContaining([
        'relative',
        'min-h-0',
        'flex-1',
        'overflow-y-auto',
        'overscroll-y-contain',
      ]),
    )
    expect(html).toMatch(/data-item-panel-scroll[^>]*>[\s\S]*BLD-4[\s\S]*Body/)
    // Without a browser there is no viewport to read: it renders as the pane.
    expect(html).not.toContain('data-sheet')
  })
})

const failed = (code: 'internal' | 'unauthorized' | 'forbidden' | 'not_found', status: number) =>
  ({ state: 'error', error: new ApiRequestError(code, 'Boom', status) }) as const

describe('HubState', () => {
  const hub = (state: Load<typeof description>, folderFound = true) =>
    render(HubState, { workspaceId: 'w', hubId: 'bld', hub: state, folderFound }, () => 'FOLDER')

  it('renders the folder once the hub is loaded', async () => {
    const html = await hub({ state: 'ready', data: description })
    expect(html).toContain('FOLDER')
  })

  it('renders the loading state', async () => {
    const html = await hub({ state: 'loading' })
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading hub')
    expect(html).not.toContain('FOLDER')
  })

  it('renders a 404 (missing, or no grant) as not found, with a way back', async () => {
    const html = await hub(failed('not_found', 404))
    expect(html).toContain('data-state="not-found"')
    expect(html).toContain('This hub is not available')
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to workspaces<\/a>/)
    expect(html).not.toContain('Try again')
    expect(html).not.toContain('FOLDER')
  })

  it('renders a 403 as no permission, with a way back', async () => {
    const html = await hub(failed('forbidden', 403))
    expect(html).toContain('data-state="no-permission"')
    expect(html).toContain('You do not have access to this hub')
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to workspaces<\/a>/)
    expect(html).not.toContain('Try again')
    expect(html).not.toContain('FOLDER')
  })

  it('renders other errors with a retry', async () => {
    const html = await hub(failed('internal', 500))
    expect(html).toContain('role="alert"')
    expect(html).toContain('The hub could not be loaded')
    expect(html).toContain('Try again')
    expect(html).not.toContain('FOLDER')
  })

  it('says when the folder is not in this hub, and links to the hub', async () => {
    const html = await hub({ state: 'ready', data: description }, false)
    expect(html).toContain('data-state="not-found"')
    expect(html).toContain('This folder is not in this hub')
    expect(html).toMatch(/<a [^>]*href="\/w\/w\/hubs\/bld"[^>]*>Open Build<\/a>/)
    expect(html).not.toContain('FOLDER')
  })
})

describe('ItemPanelBody', () => {
  const panel = (state: Load<ReturnType<typeof item>>) =>
    render(ItemPanelBody, { item: state }, () => 'DETAILS')

  it('renders the item once loaded', async () => {
    expect(await panel({ state: 'ready', data: item('i1', 1) })).toContain('DETAILS')
  })

  it('renders the loading state', async () => {
    const html = await panel({ state: 'loading' })
    expect(html).toContain('Loading item')
    expect(html).not.toContain('DETAILS')
  })

  it('renders no permission without a retry', async () => {
    const html = await panel(failed('unauthorized', 401))
    expect(html).toContain('You do not have access to this item')
    expect(html).not.toContain('Try again')
  })

  it('renders a missing item without a retry', async () => {
    const html = await panel(failed('not_found', 404))
    expect(html).toContain('data-state="not-found"')
    expect(html).toContain('This item could not be found')
    expect(html).not.toContain('Try again')
  })

  it('renders other errors with a retry', async () => {
    const html = await panel(failed('internal', 500))
    expect(html).toContain('The item could not be loaded')
    expect(html).toContain('Try again')
    expect(html).not.toContain('DETAILS')
  })
})
