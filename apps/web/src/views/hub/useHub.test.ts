import { describe, expect, it } from 'vitest'
import { description, fakeApi, folder, json } from './fixtures.test-utils.ts'
import { folderColumns, folderTree, truncatedNote, useHub } from './useHub.ts'

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

  it('leaves out a folder attribute whose attribute is missing', () => {
    const fa = description.folderAttributes[0]
    if (!fa) throw new Error('fixture has no folder attributes')
    const withGhost = {
      ...description,
      folderAttributes: [
        ...description.folderAttributes,
        { ...fa, folderId: 'bld', attributeId: 'gone', position: 1.5 },
      ],
    }
    expect(folderColumns(withGhost, 'bld').map((c) => c.attribute.id)).toEqual([
      'title',
      'stage',
      'points',
    ])
  })
})

describe('truncatedNote', () => {
  const cut = (folders: boolean, attributes: boolean, folderAttributes: boolean) =>
    truncatedNote({ ...description, truncated: { folders, attributes, folderAttributes } })

  it('says nothing when nothing was cut', () => {
    expect(cut(false, false, false)).toBe('')
  })

  it('names what was cut', () => {
    expect(cut(true, false, false)).toBe('This hub has more folders than can be shown here.')
    expect(cut(false, true, false)).toBe('This hub has more fields than can be shown here.')
    expect(cut(false, false, true)).toBe('This hub has more fields than can be shown here.')
    expect(cut(true, false, true)).toBe(
      'This hub has more folders and fields than can be shown here.',
    )
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

  it('accepts a description carrying the workspace seq (issue 168)', async () => {
    const api = fakeApi(() => json({ ...description, seq: 41 }))
    const h = useHub('w', 'bld', api.fetchFn)
    await h.load()
    expect(h.hub.value.state).toBe('ready')
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
