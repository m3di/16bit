import type { Attribute, HubDescription, Item } from '@16bit/core'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { provideValueContext, type ValueContext } from './context.ts'
import FieldEditor from './FieldEditor.vue'
import { attributes, description, fakeApi, item, json } from './fixtures.test-utils.ts'
import type { LinkedState } from './relations.ts'
import { ValueCell } from './value-cell.ts'

// Every M1 type as a table cell and as a panel editor (#50), rendered on the server.

const base = attributes[0] as Attribute
const attr = (id: string, type: Attribute['type'], config: unknown): Attribute =>
  ({ ...base, id, name: id.charAt(0).toUpperCase() + id.slice(1), type, config }) as Attribute

const tags = attr('tags', 'multi_select', {
  options: [
    { id: 'ui', label: 'UI', color: 'blue' },
    { id: 'api', label: 'API' },
    { id: 'db', label: 'DB' },
  ],
})
const link = attr('link', 'url', {})
const owners = attr('owners', 'actor', { multiple: true })
const key = attr('key', 'auto_id', { prefix: 'BLD' })
const notes = attr('notes', 'rich_text', {})
const blocks = attr('blocks', 'relation', { targetHubId: 'bld', crossHub: false, multiple: true })

const linked: Record<string, LinkedState> = {
  t1: { access: 'read', item: item('t1', 9, { title: 'Target' }) },
  t2: { access: 'none' },
  t3: { access: 'gone' },
}

function context(overrides: Partial<ValueContext> = {}): ValueContext {
  return {
    workspaceId: 'w',
    fetchFn: fakeApi(() => json({ items: [], nextCursor: null })).fetchFn,
    actor: (id) =>
      id === 'p-ana'
        ? { id, name: 'Ana', kind: 'person', known: true }
        : id === 'p-bot'
          ? { id, name: 'Reviewer', kind: 'agent', known: true }
          : { id, name: id.slice(0, 8), kind: 'person', known: false },
    actorChoices: () => [
      { id: 'p-ana', name: 'Ana', kind: 'person' },
      { id: 'p-bot', name: 'Reviewer', kind: 'agent' },
    ],
    members: () => ({ state: 'ready' }),
    retryMembers: () => undefined,
    linkState: (id) => linked[id] ?? { access: 'unknown' },
    resolveLinked: () => undefined,
    rememberLinked: () => undefined,
    hub: (id): Load<HubDescription> =>
      id === 'bld'
        ? { state: 'ready', data: description }
        : { state: 'error', error: new ApiRequestError('not_found', 'Not found', 404) },
    hubLookup: (id) => (id === 'bld' ? description : 'error'),
    ensureHubs: () => undefined,
    retryHub: () => undefined,
    itemLink: (i: Item) => ({ query: { item: i.id } }),
    ...overrides,
  }
}

async function render(c: Component, props: Record<string, unknown>, ctx = context()) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  const Host = defineComponent({
    setup() {
      provideValueContext(ctx)
      return () => h(c, props)
    },
  })
  const app = createSSRApp(Host)
  app.use(router)
  await router.push('/')
  await router.isReady()
  return renderToString(app)
}

const cell = (attribute: Attribute, value: unknown, ctx?: ValueContext) =>
  render(ValueCell, { attribute, value }, ctx)
const editor = (attribute: Attribute, value: unknown, extra: Record<string, unknown> = {}) =>
  render(FieldEditor, { attribute, value, ...extra })

describe('cells', () => {
  it('shows multi-select values as chips, two at most and a count', async () => {
    const html = await cell(tags, ['ui', 'api', 'db'])
    expect(html).toContain('aria-label="Tags"')
    expect(html).toContain('UI')
    expect(html).toContain('API')
    expect(html).not.toMatch(/>\s*DB\s*</)
    expect(html).toContain('+1')
    expect(html).toContain('data-inline')
  })

  it('links a URL without its scheme, in a new tab', async () => {
    const html = await cell(link, 'https://16bit.info/docs')
    expect(html).toContain('href="https://16bit.info/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('16bit.info/docs')
  })

  it('names actors, marks agents, and shows unnamed ones by short ID only', async () => {
    const html = await cell(owners, ['p-ana', 'p-bot'])
    expect(html).toContain('Ana')
    expect(html).toContain('Agent')
    const unknown = await cell(owners, ['0123456789abcdef'])
    expect(unknown).toContain('01234567')
    expect(unknown).toContain('data-known="false"')
    expect(unknown).toContain('data-kind="unknown"')
    expect(unknown).toContain('name not available')
  })

  it('shows an auto ID in mono with its prefix', async () => {
    const html = await cell(key, 12)
    expect(html).toContain('font-mono')
    expect(html).toContain('BLD-12')
  })

  it('shows rich text as one line of plain text', async () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
    }
    expect(await cell(notes, doc)).toContain('Hello')
  })

  it('shows readable links with ID and title, hidden ones as "No access", deleted ones not at all', async () => {
    const html = await cell(blocks, ['t1', 't2', 't3'])
    expect(html).toContain('BLD-9')
    expect(html).toContain('Target')
    expect(html).toContain('href="/?item=t1"')
    expect(html).toContain('No access')
    expect(html).toContain('data-access="none"')
    expect(html).not.toContain('data-linked="t3"')
  })

  it('says a link the query did not expand is not loaded, never guessing', async () => {
    const html = await cell(blocks, ['t9'])
    expect(html).toContain('Not loaded')
  })

  it('leaves empty values blank', async () => {
    for (const a of [tags, link, owners, blocks]) {
      expect(await cell(a, null)).not.toContain('Empty')
      expect(await cell(a, [])).not.toContain('Empty')
    }
  })
})

describe('editors', () => {
  it('edits multi-select as a group of labelled checkboxes, keeping deleted options', async () => {
    const html = await editor(tags, ['api', 'gone'])
    expect(html).toContain('<fieldset')
    expect(html).toContain('<legend')
    expect(html.match(/type="checkbox"/g)).toHaveLength(4)
    expect(html).toContain('Deleted option')
  })

  it('edits a URL in a url input', async () => {
    expect(await editor(link, 'https://16bit.info')).toContain('type="url"')
  })

  it('edits actors with remove buttons and a picker of people', async () => {
    const html = await editor(owners, ['p-ana'])
    expect(html).toContain('aria-label="Remove Ana"')
    expect(html).toContain('Add to Owners')
    expect(html).toContain('Reviewer (agent)')
  })

  it('says only the signed-in user can be added without a member list', async () => {
    const html = await render(
      FieldEditor,
      { attribute: owners, value: null },
      context({ members: () => ({ state: 'unavailable' }) }),
    )
    expect(html).toContain('no one else can be added')
  })

  it('shows an auto ID as read-only text, with no input', async () => {
    const html = await editor(key, 4)
    expect(html).toContain('BLD-4')
    expect(html).not.toContain('<input')
    expect(await editor(key, undefined)).toContain('Assigned when the item is created')
  })

  it('edits relations with removable chips and a closed picker', async () => {
    const html = await editor(blocks, ['t1', 't2'])
    expect(html).toContain('aria-label="Remove Target"')
    expect(html).toContain('aria-label="Remove this linked item"')
    expect(html).toContain('No access')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Link an item')
    expect(html).not.toContain('data-relation-picker')
  })

  it('offers to change, not add, a single-valued relation that is set', async () => {
    const single = { ...blocks, config: { ...blocks.config, multiple: false } } as Attribute
    expect(await editor(single, ['t1'])).toContain('Change link')
  })

  it('shows every type read-only after the server refused an edit', async () => {
    for (const [a, v] of [
      [tags, ['ui']],
      [owners, ['p-ana']],
      [blocks, ['t1']],
    ] as const) {
      const html = await editor(a, v, { readOnly: true })
      expect(html).toContain('You can view this but not change it.')
      expect(html).not.toContain('type="checkbox"')
      expect(html).not.toContain('<select')
      expect(html).not.toContain('Remove')
      expect(html).not.toContain('Link an item')
    }
    const text = await editor(base, 'Ship', { readOnly: true })
    expect(text).toContain('disabled')
    expect(text).toContain('You can view this but not change it.')
  })
})
