import type { Attribute, HubDescription, Item, ItemValues } from '@16bit/core'
import { defineComponent, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { provideValueContext, type ValueContext } from '../hub/context.ts'
import {
  attributes,
  description as hub,
  fakeApi,
  folder,
  item,
  json,
} from '../hub/fixtures.test-utils.ts'
import { provideViewHost, type ViewHost } from './host.ts'

// A backlog-like hub for the data blocks, shaped as the core contracts say. Tests only.

const base = attributes[0] as Attribute
const attr = (id: string, name: string, type: Attribute['type'], config: unknown, indexed = true) =>
  ({ ...base, id, name, type, config, indexed }) as Attribute

export const dataAttributes: Attribute[] = [
  ...attributes,
  attr('key', 'ID', 'auto_id', { prefix: 'PT' }),
  attr('owner', 'Owner', 'actor', { multiple: false }),
  attr('epic', 'Epic', 'relation', { targetHubId: 'bld', crossHub: false, multiple: false }),
  attr('start', 'Start', 'date', { includeTime: false }),
  attr('end', 'End', 'date', { includeTime: false }),
  attr('done', 'Done on', 'date', { includeTime: false }),
]

const shows = (folderId: string, ids: string[]) =>
  ids.map((attributeId, position) => ({
    workspaceId: 'w',
    hubId: 'bld',
    folderId,
    attributeId,
    position,
    required: attributeId === 'title',
  }))

export const dataDescription: HubDescription = {
  ...hub,
  attributes: dataAttributes,
  folders: [
    folder('b', 'bld', 'Backlog'),
    folder('sp', 'bld', 'Sprints'),
    { ...folder('home', 'bld', 'Home'), viewsOnly: true },
  ],
  folderAttributes: [
    ...shows('bld', ['title']),
    ...shows('b', ['title', 'key', 'stage', 'points', 'owner', 'epic', 'done']),
    ...shows('sp', ['title', 'start', 'end']),
  ],
}

export const task = (id: string, seqId: number, values: ItemValues = {}): Item => ({
  ...item(id, seqId, values),
  folderId: 'b',
})

export function valueContext(): ValueContext {
  return {
    workspaceId: 'w',
    fetchFn: fakeApi(() => json({ items: [], nextCursor: null })).fetchFn,
    actor: (id) =>
      id === 'p-sara'
        ? { id, name: 'Sara', kind: 'person', known: true }
        : { id, name: id.slice(0, 8), kind: 'person', known: false },
    actorChoices: () => [],
    members: () => ({ state: 'ready' }),
    retryMembers: () => undefined,
    linkState: () => ({ access: 'unknown' }),
    resolveLinked: () => undefined,
    rememberLinked: () => undefined,
    hub: (id): Load<HubDescription> =>
      id === 'bld'
        ? { state: 'ready', data: dataDescription }
        : { state: 'error', error: new ApiRequestError('not_found', 'Not found', 404) },
    hubLookup: (id) => (id === 'bld' ? dataDescription : 'error'),
    ensureHubs: () => undefined,
    retryHub: () => undefined,
    itemLink: (i: Item) => ({ query: { item: i.id } }),
  }
}

export interface TestHost extends ViewHost {
  created: { folderId: string; values: ItemValues }[]
}

export function testHost(overrides: Partial<ViewHost> = {}): TestHost {
  const created: TestHost['created'] = []
  return {
    created,
    description: () => dataDescription,
    current: (i) => i,
    itemLink: (i) => ({ query: { item: i.id } }),
    canCreate: () => true,
    create: (folderId, values) => {
      created.push({ folderId, values })
    },
    me: () => 'p-sara',
    ...overrides,
  }
}

/** Renders `c` on the server under a host and a value context, as the hub page provides them. */
export async function renderWith(
  c: Component,
  props: Record<string, unknown>,
  host: ViewHost = testHost(),
) {
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
  const Host = defineComponent({
    setup() {
      provideValueContext(valueContext())
      provideViewHost(host)
      return () => h(c, props)
    },
  })
  const app = createSSRApp(Host)
  app.use(router)
  await router.push('/w/w/hubs/bld/home')
  await router.isReady()
  return renderToString(app)
}

/** Text without markup, whitespace squeezed. */
export const plain = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
