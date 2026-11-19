import type { Backlink, HubDescription, Item } from '@16bit/core'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { provideValueContext, type ValueContext } from '../hub/context.ts'
import { description, fakeApi, item, json } from '../hub/fixtures.test-utils.ts'
import { folderColumns } from '../hub/useHub.ts'
import BacklinksBlock from './BacklinksBlock.vue'
import ItemBody from './ItemBody.vue'
import ItemState from './ItemState.vue'
import { itemPageLink, type PageState } from './item-page.ts'
import type { BacklinkList } from './useBacklinks.ts'

// The item page (#119), rendered on the server.

const titled: HubDescription = {
  ...description,
  hub: { ...description.hub, titleAttributeId: 'title' },
}

function context(): ValueContext {
  return {
    workspaceId: 'w',
    fetchFn: fakeApi(() => json({ items: [], nextCursor: null })).fetchFn,
    actor: (id) =>
      id === 'lead'
        ? { id, name: 'Lea Lead', kind: 'person', known: true }
        : { id, name: id.slice(0, 8), kind: 'person', known: false },
    actorChoices: () => [],
    members: () => ({ state: 'ready' }),
    retryMembers: () => undefined,
    linkState: () => ({ access: 'unknown' }),
    resolveLinked: () => undefined,
    rememberLinked: () => undefined,
    hub: (): Load<HubDescription> => ({ state: 'ready', data: titled }),
    hubLookup: (id) => (id === 'bld' ? titled : 'error'),
    ensureHubs: () => undefined,
    retryHub: () => undefined,
    itemLink: (i: Item) => itemPageLink('w', i),
  }
}

async function render(c: Component, props: Record<string, unknown>, slot?: () => unknown) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/w/:workspaceId/hubs/:hubId/:folderId?',
        name: 'hub',
        component: { render: () => null },
      },
      { path: '/w/:workspaceId/items/:itemId', name: 'item', component: { render: () => null } },
    ],
  })
  const Host = defineComponent({
    setup() {
      provideValueContext(context())
      return () => h(c, props, slot ? { default: slot } : undefined)
    },
  })
  const app = createSSRApp(Host)
  app.use(router)
  await router.push('/')
  await router.isReady()
  return renderToString(app)
}

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('ItemState', () => {
  const error = (status: number) => new ApiRequestError('x' as never, 'Server says no', status)
  const state = (page: PageState) => render(ItemState, { page }, () => 'BODY')

  it('shows loading, then the body once ready', async () => {
    expect(await state({ state: 'loading' })).toContain('Loading item')
    const ready = await state({ state: 'ready', item: item('i1', 1), hub: description })
    expect(ready).toContain('BODY')
  })

  it('says not available for a 404, without claiming the item does not exist', async () => {
    const html = await state({ state: 'not-found', error: error(404) })
    expect(html).toContain('data-state="not-found"')
    expect(text(html)).toContain('This item is not available')
    expect(text(html)).toContain('It may not exist, or it may not be shared with you.')
    expect(html).toContain('href="/"')
    expect(html).not.toContain('Try again')
  })

  it('shows no permission and error with a retry', async () => {
    expect(await state({ state: 'no-permission', error: error(403) })).toContain(
      'data-state="no-permission"',
    )
    const failed = await state({ state: 'error', error: error(500) })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Server says no')
    expect(failed).toContain('Try again')
  })
})

const readyLinks = (entries: Backlink[] = [], hidden = 0, nextCursor: string | null = null) =>
  ({
    state: 'ready',
    data: { entries, hidden, nextCursor, more: false, moreError: null },
  }) as Load<BacklinkList>

function body(overrides: Record<string, unknown> = {}) {
  const shown = (overrides['item'] as Item | undefined) ?? item('i1', 12, { title: 'Ship it' })
  const hub = (overrides['hub'] as HubDescription | undefined) ?? titled
  return render(ItemBody, {
    workspaceId: 'w',
    item: shown,
    hub,
    columns: folderColumns(hub, shown.folderId),
    backlinks: readyLinks(),
    readOnly: false,
    saving: false,
    ...overrides,
  })
}

describe('ItemBody', () => {
  it("titles the item from the hub's title attribute, with the trail and the mono ID", async () => {
    const html = await body()
    expect(html).toMatch(/<h1[^>]*>\s*Ship it\s*<\/h1>/)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toContain('href="/w/w/hubs/bld"')
    expect(html).toMatch(/aria-current="page"[^>]*>BLD-12</)
  })

  it('links the folder in the trail when the item is in one', async () => {
    const html = await body({ item: { ...item('i1', 12, { title: 'Ship it' }), folderId: 'b' } })
    expect(html).toContain('href="/w/w/hubs/bld/b"')
    expect(text(html)).toContain('Bugs')
  })

  it('shows only the mono ID when the hub has no title attribute (D50)', async () => {
    const html = await body({ hub: description })
    expect(html).toMatch(/<h1 class="[^"]*font-mono[^"]*"[^>]*>\s*BLD-12\s*<\/h1>/)
    expect(html).not.toMatch(/<h1[^>]*>\s*Ship it/)
  })

  it('renders an editor for every attribute of the folder, and the details', async () => {
    const html = await body()
    expect(text(html)).toContain('Title (required)')
    expect(text(html)).toContain('Stage')
    expect(text(html)).toContain('Points')
    expect(html).toContain('value="Ship it"')
    expect(html).toMatch(/data-item-version[^>]*>1</)
    expect(text(html)).toContain('Lea Lead')
    expect(html).toContain('data-delete-item')
    expect(html).not.toContain('data-read-only')
  })

  it('is read-only without Delete for a reader who cannot change items', async () => {
    const html = await body({ readOnly: true })
    expect(html).toContain('data-read-only')
    expect(html).not.toContain('data-delete-item')
    expect(html).toContain('You can view this but not change it.')
    expect(html).toMatch(/<input[^>]*disabled/)
  })

  it('shows a failed write as a notice, and that an edit is saving', async () => {
    const html = await body({
      saving: true,
      notice: 'BLD-12 was changed by someone else before your edit was saved.',
    })
    expect(html).toContain('data-notice')
    expect(html).toContain('role="alert"')
    expect(html).toContain('changed by someone else')
    expect(html).toContain('Saving…')
  })

  it('says so when the folder has no fields', async () => {
    const html = await body({ columns: [] })
    expect(html).toContain('This folder has no fields yet.')
  })
})

describe('BacklinksBlock', () => {
  const links = (list: Load<BacklinkList>) => render(BacklinksBlock, { list })

  it('lists linking items as chips to their page, with the attribute they link through', async () => {
    const html = await links(
      readyLinks([{ attributeId: 'title', item: item('a', 3, { title: 'Parent' }) }]),
    )
    expect(html).toContain('data-backlink="a"')
    expect(html).toContain('BLD-3')
    expect(html).toContain('href="/w/w/items/a"')
    expect(text(html)).toContain('Parent')
    expect(text(html)).toContain('in Title')
    expect(html).not.toContain('data-backlinks-empty')
  })

  it('counts hidden links without naming them', async () => {
    const html = await links(readyLinks([], 3))
    expect(text(html)).toContain('3 links from items you cannot see.')
    expect(html).not.toContain('data-backlinks-empty')
  })

  it('says when nothing links here', async () => {
    expect(await links(readyLinks())).toContain('No items link here.')
  })

  it('offers more when there is another page', async () => {
    expect(await links(readyLinks([], 0, 'c1'))).toContain('Show more')
  })

  it('shows loading and error states', async () => {
    expect(await links({ state: 'loading' })).toContain('Loading links')
    const failed = await links({
      state: 'error',
      error: new ApiRequestError('internal', 'Down', 500),
    })
    expect(failed).toContain('Links to this item could not be loaded')
    expect(failed).toContain('Try again')
  })
})
