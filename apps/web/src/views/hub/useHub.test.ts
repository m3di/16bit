import { describe, expect, it } from 'vitest'
import { description, fakeApi, folder, json } from './fixtures.ts'
import { folderColumns, folderTree, useHub } from './useHub.ts'

describe('folderTree', () => {
  it('puts the hub first, then folders by parent with children under them', () => {
    const tree = folderTree(description).map((e) => [e.folder.id, e.depth])
    expect(tree).toEqual([
      ['bld', 0],
      ['b', 0],
      ['a', 0],
      ['a1', 1],
    ])
  })

  it('still lists a folder whose parent is missing', () => {
    const orphan = { ...folder('x', 'gone') }
    const tree = folderTree({ ...description, folders: [orphan] })
    expect(tree.map((e) => e.folder.id)).toEqual(['bld', 'x'])
  })
})

describe('folderColumns', () => {
  it('returns the folder attributes in position order with required flags', () => {
    expect(folderColumns(description, 'bld').map((c) => [c.attribute.id, c.required])).toEqual([
      ['title', true],
      ['stage', false],
      ['points', false],
    ])
    expect(folderColumns(description, 'a')).toEqual([])
  })
})

describe('useHub', () => {
  it('loads the hub description', async () => {
    const api = fakeApi(() => json(description))
    const h = useHub('w', 'bld', api.fetchFn)
    await h.load()
    expect(api.calls[0]?.path).toBe('/v1/workspaces/w/hubs/bld')
    expect(h.hub.value.state).toBe('ready')
    expect(h.tree.value).toHaveLength(4)
  })

  it('reports a missing hub as a 404 error', async () => {
    const api = fakeApi(() => json({ error: 'not_found', message: 'Hub not found' }, 404))
    const h = useHub('w', 'nope', api.fetchFn)
    await h.load()
    expect(h.hub.value).toMatchObject({ state: 'error', error: { status: 404 } })
  })

  it('sends one request for two quick retries', async () => {
    const api = fakeApi(() => json(description))
    const h = useHub('w', 'bld', api.fetchFn)
    await Promise.all([h.load(), h.load()])
    expect(api.calls).toHaveLength(1)
  })
})
