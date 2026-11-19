import type { Attribute, Folder, HubDescription, Item } from '@16bit/core'
import type { Fetch } from '../../api/client.ts'

// Shared test data for the hub view. Only imported by tests.

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

export interface Call {
  method: string
  path: string
  body: unknown
}

/** A fake API. `handler` answers each call; every call is recorded. */
export function fakeApi(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchFn: Fetch = async (input, init) => {
    const url = new URL(urlOf(input), 'http://x')
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return handler(call)
  }
  return { fetchFn, calls }
}

export const folder = (id: string, parentId: string | null, name = id): Folder => ({
  workspaceId: 'w',
  id,
  hubId: 'bld',
  parentId,
  name,
  color: 'teal',
  idPrefix: 'BLD',
  itemCount: 2,
  version: 1,
})

export const attributes: Attribute[] = [
  {
    workspaceId: 'w',
    id: 'title',
    hubId: 'bld',
    name: 'Title',
    indexed: false,
    version: 0,
    type: 'text',
    config: {},
  },
  {
    workspaceId: 'w',
    id: 'stage',
    hubId: 'bld',
    name: 'Stage',
    indexed: true,
    version: 0,
    type: 'select',
    config: {
      options: [
        { id: 'todo', label: 'To do' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  },
  {
    workspaceId: 'w',
    id: 'points',
    hubId: 'bld',
    name: 'Points',
    indexed: false,
    version: 0,
    type: 'number',
    config: { format: 'plain' },
  },
]

export const description: HubDescription = {
  hub: { ...folder('bld', null, 'Build'), parentId: null, titleAttributeId: null },
  hubRole: 'hub_admin',
  folders: [folder('b', 'bld', 'Bugs'), folder('a', 'bld', 'Archive'), folder('a1', 'a', 'Old')],
  attributes,
  truncated: { folders: false, attributes: false, folderAttributes: false },
  folderAttributes: [
    {
      workspaceId: 'w',
      hubId: 'bld',
      folderId: 'bld',
      attributeId: 'stage',
      position: 1,
      required: false,
    },
    {
      workspaceId: 'w',
      hubId: 'bld',
      folderId: 'bld',
      attributeId: 'title',
      position: 0,
      required: true,
    },
    {
      workspaceId: 'w',
      hubId: 'bld',
      folderId: 'bld',
      attributeId: 'points',
      position: 2,
      required: false,
    },
    {
      workspaceId: 'w',
      hubId: 'bld',
      folderId: 'b',
      attributeId: 'title',
      position: 0,
      required: true,
    },
  ],
}

export const item = (
  id: string,
  seqId: number,
  values: Item['values'] = {},
  version = 1,
): Item => ({
  workspaceId: 'w',
  id,
  hubId: 'bld',
  folderId: 'bld',
  seqId,
  values,
  version,
  updatedAt: '2026-11-16T10:00:00.000Z',
  updatedBy: 'lead',
})
