import { defaultViewTree, type ViewData } from '@16bit/core'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import { description } from '../hub-settings/fixtures.test-utils.ts'
import { createRequestQueue } from '../root-view/queue.ts'
import type { RawView, ViewSource, ViewWrites } from '../root-view/source.ts'
import { composerSchema } from './tree.ts'
import { useViewComposer } from './useViewComposer.ts'

// The composer's flows against a fake view API: save with the version, a 409 and Reload, 422
// errors at their paths, and Reset (a 404 is "already the default", lead note on the issue).

const view = (
  version: number,
  tree: unknown = defaultViewTree('backlog', { viewsOnly: false }),
): RawView => ({
  folderId: 'backlog',
  hubId: 'bld',
  stored: version > 0,
  version,
  tree,
  updatedAt: null,
  updatedBy: null,
  seq: 1,
})

function fakeApi(handlers: Partial<ViewSource & ViewWrites> = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const api: ViewSource & ViewWrites = {
    view: (...args) => {
      calls.push({ method: 'view', args })
      return handlers.view ? handlers.view(...args) : Promise.resolve(view(0))
    },
    data: (...args) => {
      calls.push({ method: 'data', args })
      return handlers.data
        ? handlers.data(...args)
        : Promise.resolve<ViewData>({ folderId: 'backlog', version: 0, blocks: {}, seq: 1 })
    },
    put: (...args) => {
      calls.push({ method: 'put', args })
      return handlers.put ? handlers.put(...args) : Promise.resolve(view(1, args[2]))
    },
    reset: (...args) => {
      calls.push({ method: 'reset', args })
      return handlers.reset ? handlers.reset(...args) : Promise.resolve()
    },
  }
  return { api, calls }
}

const schema = composerSchema(description())
const compose = (api: ViewSource & ViewWrites) =>
  useViewComposer({ api, schema: () => schema, queue: createRequestQueue(), timeZone: 'UTC' })

describe('useViewComposer', () => {
  it('starts from the default view, adds a block, and saves the tree at version 0', async () => {
    const { api, calls } = fakeApi()
    const c = compose(api)
    await c.load('backlog')
    expect(c.dirty.value).toBe(false)
    expect(c.add('page', 'heading')).toBe('heading')
    expect(c.dirty.value).toBe(true)
    expect(await c.save()).toBe(true)
    const put = calls.find((x) => x.method === 'put')
    expect(put?.args.slice(0, 2)).toEqual(['backlog', 0])
    const tree = put?.args[2] as { root: { children: { type: string }[] } }
    expect(tree.root.children.map((b) => b.type)).toEqual(['table', 'heading'])
    expect(c.saved.value?.version).toBe(1)
    expect(c.dirty.value).toBe(false)
    expect(c.notice.value?.tone).toBe('info')
  })

  it('does not send a draft core refuses, and says how many problems to fix', async () => {
    const { api, calls } = fakeApi()
    const c = compose(api)
    await c.load('backlog')
    const id = c.add('page', 'heading')
    const block = c.blocks.value.find((l) => l.block.id === id)?.block
    if (block) block.config['text'] = ''
    expect(await c.save()).toBe(false)
    expect(calls.some((x) => x.method === 'put')).toBe(false)
    expect(c.notice.value?.text).toContain('Fix the problem marked below first')
    expect(c.errors.value.map((e) => e.path)).toEqual(['root.children.1.config.text'])
  })

  it('on a 409 keeps the draft, says so, and Reload composes on their version', async () => {
    const theirs = view(4)
    const { api } = fakeApi({
      put: () =>
        Promise.reject(
          new ApiRequestError('conflict', 'Stale', 409, {
            error: 'conflict',
            message: 'Stale',
            current: theirs,
          }),
        ),
    })
    const c = compose(api)
    await c.load('backlog')
    c.add('page', 'text')
    expect(await c.save()).toBe(false)
    expect(c.notice.value?.tone).toBe('conflict')
    expect(c.dirty.value).toBe(true)
    c.reload()
    expect(c.saved.value?.version).toBe(4)
    expect(c.dirty.value).toBe(false)
  })

  it('shows the server’s 422 errors at their paths until the draft changes', async () => {
    const { api } = fakeApi({
      put: () =>
        Promise.reject(
          new ApiRequestError('invalid_view', 'The view is not valid', 422, {
            error: 'invalid_view',
            message: 'The view is not valid',
            errors: [{ path: 'root.children.0.config.binding.folderId', message: 'Folder gone' }],
          }),
        ),
    })
    const c = compose(api)
    await c.load('backlog')
    c.add('page', 'text')
    await c.save()
    expect(c.serverErrors.value).toEqual([
      { path: 'root.children.0.config.binding.folderId', message: 'Folder gone' },
    ])
    expect(c.errors.value.map((e) => e.message)).toContain('Folder gone')
    expect(c.notice.value?.text).toContain('a problem, marked below')
    c.remove('text')
    await nextTick()
    expect(c.serverErrors.value).toEqual([])
  })

  it('resets with the version, and treats a 404 as already the default', async () => {
    let stored = true
    const { api, calls } = fakeApi({
      view: () => Promise.resolve(stored ? view(3) : view(0)),
      reset: () => {
        stored = false
        return Promise.reject(new ApiRequestError('not_found', 'No view', 404))
      },
    })
    const c = compose(api)
    await c.load('backlog')
    expect(await c.reset()).toBe(true)
    expect(calls.find((x) => x.method === 'reset')?.args).toEqual(['backlog', 3])
    expect(c.saved.value?.stored).toBe(false)
    expect(c.notice.value).toEqual({
      tone: 'info',
      text: 'This folder already opens on its default view.',
    })
  })

  it('gives the preview the stored data of unchanged blocks only', async () => {
    const { api } = fakeApi({
      data: () =>
        Promise.resolve({
          folderId: 'backlog',
          version: 0,
          seq: 1,
          blocks: { table: { status: 'ok', data: { kind: 'items', items: [], total: 0 } } },
        }),
    })
    const c = compose(api)
    await c.load('backlog')
    await new Promise((r) => setTimeout(r, 0))
    expect(c.storedData.value['table']?.state).toBe('ready')
    expect([...c.unsaved.value]).toEqual([])
    const table = c.blocks.value.find((l) => l.block.id === 'table')?.block
    if (table) table.config['binding'] = { folderId: 'bld', sort: [], limit: 10 }
    c.add('page', 'number')
    expect([...c.unsaved.value].sort()).toEqual(['number', 'table'])
  })
})
