import {
  VIEW_SCHEMA_VERSION,
  type BlockInput,
  type BlockStatus,
  type HubDescription,
  type Item,
  type ViewData,
  type ViewTreeInput,
} from '@16bit/core'
import { description as hubDescription, folder, item } from '../hub/fixtures.test-utils.ts'
import type { RawView, ViewDataRequest, ViewSource } from './source.ts'

// Views and view data shaped as `views.ts` and `view-data.ts` say, for tests only.

/** The fixture hub with a views-only Home folder it opens on, and a Sprints folder. */
export const description: HubDescription = {
  ...hubDescription,
  hub: { ...hubDescription.hub, opensOnFolderId: 'home' },
  folders: [
    ...hubDescription.folders,
    { ...folder('home', 'bld', 'Home'), viewsOnly: true },
    folder('sp', 'bld', 'Sprints'),
  ],
}

export const page = (children: BlockInput[], title?: string): ViewTreeInput => ({
  schemaVersion: VIEW_SCHEMA_VERSION,
  root: { id: 'page', type: 'page', config: title ? { title } : {}, children },
})

/** Home as the mockups compose it, cut down: every layout and content type and some data. */
export const homeTree: ViewTreeInput = page(
  [
    { id: 'intro', type: 'text', config: { text: 'What the team is on.\nUpdated live.' } },
    { id: 'h-top', type: 'heading', config: { text: 'This week', level: 1 } },
    {
      id: 'sprint',
      type: 'fields',
      config: {
        binding: {
          by: 'rule',
          folderId: 'sp',
          where: { attribute: 'stage', op: 'eq', value: 'todo' },
        },
        fields: ['title'],
      },
    },
    {
      id: 'backlog-section',
      type: 'section',
      config: { title: 'Backlog' },
      children: [
        { id: 'h-deep', type: 'heading', config: { text: 'Next up', level: 3 } },
        { id: 'backlog', type: 'list', config: { binding: { folderId: 'b' } } },
      ],
    },
    {
      id: 'numbers',
      type: 'columns',
      config: {},
      children: [
        {
          id: 'open',
          type: 'number',
          config: {
            kind: 'aggregate',
            label: 'Open bugs',
            binding: { folderId: 'b' },
            value: { fn: 'count' },
          },
        },
        {
          id: 'day',
          type: 'number',
          config: {
            kind: 'days',
            binding: {
              by: 'rule',
              folderId: 'sp',
              where: { attribute: 'stage', op: 'eq', value: 'todo' },
            },
            start: 'due',
            end: 'due',
          },
        },
      ],
    },
    {
      id: 'in-sprint',
      type: 'board',
      config: {
        binding: {
          folderId: 'bld',
          where: { attribute: 'rel', op: 'in', value: [{ $block: 'sprint' }] },
        },
        column: { attribute: 'stage', options: [{ option: 'todo' }, { option: 'done' }] },
      },
    },
  ],
  'Home',
)

export const rawView = (folderId: string, tree: unknown, more: Partial<RawView> = {}): RawView => ({
  folderId,
  hubId: 'bld',
  stored: true,
  version: 3,
  tree,
  updatedAt: '2026-11-20T10:00:00.000Z',
  updatedBy: 'lead',
  seq: 40,
  ...more,
})

export const ok = (items: Item[] = []): BlockStatus => ({
  status: 'ok',
  data: { kind: 'items', items, total: items.length },
})

export const viewData = (
  blocks: Record<string, BlockStatus>,
  more: Partial<ViewData> = {},
): ViewData => ({ folderId: 'home', version: 3, blocks, seq: 41, ...more })

/** Every data block of `homeTree` answered `ok`. */
export const homeData = (only?: readonly string[]) =>
  viewData(
    Object.fromEntries(
      ['sprint', 'backlog', 'open', 'day', 'in-sprint']
        .filter((id) => !only || only.includes(id))
        .map((id): [string, BlockStatus] => [
          id,
          id === 'sprint'
            ? { status: 'ok', data: { kind: 'item', item: item('s1', 1) } }
            : id === 'backlog'
              ? ok([{ ...item('i1', 2), folderId: 'b' }])
              : id === 'day'
                ? { status: 'ok', data: { kind: 'days', day: 6, of: 10 } }
                : ok(),
        ]),
    ),
  )

export interface FakeSource extends ViewSource {
  views: RawView[]
  requests: { folderId: string; request: ViewDataRequest }[]
  /** Answers the next data request with this, or throws it. */
  answer: (fn: (folderId: string, request: ViewDataRequest) => ViewData | Promise<ViewData>) => void
}

/** A source answering `view` from `views` (by folder) and `data` with `homeData`. */
export function fakeSource(views: RawView[]): FakeSource {
  let respond = (_f: string, request: ViewDataRequest): ViewData | Promise<ViewData> =>
    homeData(request.blocks)
  const source: FakeSource = {
    views,
    requests: [],
    answer: (fn) => {
      respond = fn
    },
    view: (folderId) => {
      const v = source.views.find((x) => x.folderId === folderId)
      return Promise.resolve(v ?? rawView(folderId, null, { stored: false, version: 0 }))
    },
    data: async (folderId, request) => {
      source.requests.push({ folderId, request })
      return respond(folderId, request)
    },
  }
  return source
}
