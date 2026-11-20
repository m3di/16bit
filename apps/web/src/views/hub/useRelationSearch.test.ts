import type { HubDescription } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { attributes, description, fakeApi, item, json } from './fixtures.test-utils.ts'
import { PICKER_PAGE, useRelationSearch } from './useRelationSearch.ts'

const indexed: HubDescription = {
  ...description,
  attributes: attributes.map((a) => (a.id === 'title' ? { ...a, indexed: true } : a)),
}

const results = [item('a', 1, { title: 'Alpha' }), item('b', 2, { title: 'Beta' })]

describe('useRelationSearch', () => {
  it('searches the title on the server when it is indexed', async () => {
    const api = fakeApi(() => json({ items: results, nextCursor: null }))
    const s = useRelationSearch('w', () => indexed, api.fetchFn)
    s.text.value = ' alp '
    await s.search()
    expect(api.calls[0]).toEqual({
      method: 'POST',
      path: '/v1/workspaces/w/query',
      body: {
        from: 'bld',
        where: { attribute: 'title', op: 'contains', value: 'alp' },
        limit: PICKER_PAGE,
        cursor: null,
      },
    })
    expect(s.local.value).toBe(false)
    // The server matched; nothing is filtered again here. Already linked items are left out.
    expect(s.offered(['b']).map((i) => i.id)).toEqual(['a'])
  })

  it('accepts a page carrying the workspace seq (issue 168)', async () => {
    // From M3-03 a query result carries `seq` (D58); no `linked` or `total` without expand or
    // count.
    const api = fakeApi(() => json({ items: results, nextCursor: null, seq: 12 }))
    const s = useRelationSearch('w', () => indexed, api.fetchFn)
    await s.search()
    expect(s.results.value).toMatchObject({ state: 'ready' })
    expect(s.offered([]).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('filters loaded items itself when the title is not indexed', async () => {
    const api = fakeApi(() => json({ items: results, nextCursor: 'c1' }))
    const s = useRelationSearch('w', () => description, api.fetchFn)
    s.text.value = 'bet'
    await s.search()
    expect(api.calls[0]?.body).toMatchObject({ where: null })
    expect(s.local.value).toBe(true)
    expect(s.offered([]).map((i) => i.id)).toEqual(['b'])
    s.text.value = 'bld-1'
    await s.search()
    expect(s.offered([]).map((i) => i.id)).toEqual(['a'])
  })

  it('searches another folder of the target hub', async () => {
    const api = fakeApi(() => json({ items: [], nextCursor: null }))
    const s = useRelationSearch('w', () => description, api.fetchFn)
    s.setFolder('b')
    await new Promise((r) => setTimeout(r, 0))
    expect(api.calls[0]?.body).toMatchObject({ from: 'b' })
  })

  it('reports a folder the reader cannot see', async () => {
    const api = fakeApi(() => json({ error: 'not_found', message: 'Not found' }, 404))
    const s = useRelationSearch('w', () => description, api.fetchFn)
    await s.search()
    expect(s.results.value).toMatchObject({ state: 'error', error: { status: 404 } })
    expect(s.offered([])).toEqual([])
  })
})
