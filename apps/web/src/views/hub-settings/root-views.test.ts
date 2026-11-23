// @vitest-environment client-node
import { defaultViewTree, type ViewData } from '@16bit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ApiRequestError } from '../../api/client.ts'
import { findAll, fire, mount, setLayout, type FakeNode } from '../../test/fake-dom.ts'
import { fakeApi as fakeFetch, json } from '../hub/fixtures.test-utils.ts'
import type { RawView, ViewSource, ViewWrites } from '../root-view/source.ts'
import { description, HUB, WS } from './fixtures.test-utils.ts'
import RootViewsSection from './RootViewsSection.vue'
import { useHubAccess } from './useHubAccess.ts'

// The composer in the browser build: the outline, adding a block from the allowed types, Save
// with the version, and a 422's errors shown on the field at their path.

beforeEach(() => {
  vi.stubGlobal('HTMLElement', function HTMLElement() {})
  vi.stubGlobal('document', { activeElement: null, body: {} })
  setLayout((el) => {
    if (el.tag === 'select') Object.assign(el, { options: [] })
    if (el.tag !== 'dialog') return
    Object.assign(el, {
      open: false,
      showModal: () => Object.assign(el, { open: true }),
      close: () => Object.assign(el, { open: false }),
    })
  })
})
afterEach(() => {
  setLayout(null)
  vi.unstubAllGlobals()
})

const textOf = (n: FakeNode): string =>
  n.tag === '#comment' ? '' : n.text + n.children.map(textOf).join('')
const squeeze = (n: FakeNode) => textOf(n).replace(/\s+/g, ' ').trim()
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const button = (root: FakeNode, text: string) => {
  const b = findAll(root, (n) => n.tag === 'button' && squeeze(n) === text)[0]
  if (!b) throw new Error(`no button "${text}"`)
  return b
}
/** Picks an option of a native select, as v-model reads it on `change`. */
function choose(select: FakeNode, value: string) {
  const options = findAll(select, (n) => n.tag === 'option')
  for (const o of options) Object.assign(o, { selected: o.value === value })
  Object.assign(select, { options })
  fire(select, 'change')
}
/** The field whose label reads `label`: the label's wrapper. */
const field = (root: FakeNode, label: string) => {
  const l = findAll(root, (n) => n.tag === 'label' && squeeze(n) === label)[0]
  if (!l?.parent) throw new Error(`no field "${label}"`)
  return l.parent
}

const stored = (version: number, tree: unknown): RawView => ({
  folderId: 'backlog',
  hubId: HUB,
  stored: version > 0,
  version,
  tree,
  updatedAt: null,
  updatedBy: null,
  seq: 1,
})

async function open(put: ViewWrites['put']) {
  const puts: unknown[][] = []
  const api: ViewSource & ViewWrites = {
    view: () => Promise.resolve(stored(0, defaultViewTree('backlog', { viewsOnly: false }))),
    data: () =>
      Promise.resolve<ViewData>({
        folderId: 'backlog',
        version: 0,
        seq: 1,
        blocks: { table: { status: 'ok', data: { kind: 'items', items: [], total: 0 } } },
      }),
    put: (...args) => {
      puts.push(args)
      return put(...args)
    },
    reset: () => Promise.resolve(),
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/w/:workspaceId/hubs/:hubId/:folderId?',
        name: 'hub',
        component: { render: () => null },
      },
      {
        path: '/w/:workspaceId/hubs/:hubId/settings/views',
        name: 'hub-settings-views',
        component: { render: () => null },
      },
    ],
  })
  await router.push(`/w/${WS}/hubs/${HUB}/settings/views?folder=backlog`)
  const access = useHubAccess(
    WS,
    HUB,
    fakeFetch(() => json({ items: [], nextCursor: null })).fetchFn,
  )
  const { root } = mount(
    RootViewsSection,
    { description: description(), manages: true, access, api, me: 'p-sara' },
    [router],
  )
  await flush()
  await flush()
  return { root, puts }
}

describe('the root view composer', () => {
  it('outlines the default view, adds a list, previews it unsaved, and saves at version 0', async () => {
    const { root, puts } = await open((_, __, tree) => Promise.resolve(stored(1, tree)))
    const outline = findAll(root, (n) => n.props['data-composer-outline'] !== undefined)[0]
    if (!outline) throw new Error('no outline')
    expect(squeeze(outline)).toContain('Page')
    expect(squeeze(outline)).toContain('Table: Backlog')
    // The page is selected: it may hold a list.
    const add = findAll(root, (n) => n.props['data-composer-add'] !== undefined)[0]
    const select = add && findAll(add, (n) => n.tag === 'select')[0]
    if (!select) throw new Error('no add select')
    const offered = findAll(select, (n) => n.tag === 'option').map((o) => o.value)
    expect(offered).toEqual([
      'section',
      'columns',
      'heading',
      'text',
      'table',
      'list',
      'board',
      'number',
      'chart',
      'fields',
    ])
    choose(select, 'list')
    fire(button(root, 'Add block'), 'click')
    await flush()
    expect(squeeze(outline)).toContain('List: Backlog')
    expect(squeeze(root)).toContain('Items from')
    // The new list has no data until saved; the table keeps the stored view's.
    const unsaved = findAll(root, (n) => n.props['data-block-unsaved'] !== undefined)
    expect(unsaved.map((n) => n.props['data-view-block'])).toEqual(['list'])

    fire(button(root, 'Save view'), 'click')
    await flush()
    expect(puts).toHaveLength(1)
    expect(puts[0]?.slice(0, 2)).toEqual(['backlog', 0])
    const tree = puts[0]?.[2] as { root: { children: { id: string }[] } }
    expect(tree.root.children.map((b) => b.id)).toEqual(['table', 'list'])
    expect(squeeze(root)).toContain('Saved. The folder opens on this view (version 1).')
  })

  it('shows a 422’s errors on the field at their path', async () => {
    const { root } = await open(() =>
      Promise.reject(
        new ApiRequestError('invalid_view', 'The view is not valid', 422, {
          error: 'invalid_view',
          message: 'The view is not valid',
          errors: [
            { path: 'root.children.1.config.binding.folderId', message: 'Folder "x" is gone' },
            { path: 'root.children.1.id', message: 'Block ID "list" is already used' },
          ],
        }),
      ),
    )
    const add = findAll(root, (n) => n.props['data-composer-add'] !== undefined)[0]
    const select = add && findAll(add, (n) => n.tag === 'select')[0]
    if (!select) throw new Error('no add select')
    choose(select, 'list')
    fire(button(root, 'Add block'), 'click')
    await flush()
    fire(button(root, 'Save view'), 'click')
    await flush()
    expect(squeeze(root)).toContain('The server found 2 problems, marked below.')
    expect(squeeze(field(root, 'Items from'))).toContain('Folder "x" is gone')
    // A problem no field shows is listed on the block.
    const blockErrors = findAll(root, (n) => n.props['data-block-errors'] !== undefined)[0]
    expect(blockErrors && squeeze(blockErrors)).toContain('Block ID "list" is already used (at id)')
    // The outline marks the block.
    const row = findAll(root, (n) => n.props['data-outline-block'] === 'list')[0]
    expect(row && squeeze(row)).toContain('2 problems')
  })
})
