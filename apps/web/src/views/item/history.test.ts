import type { RevisionEntry } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { fakeApi, json } from '../hub/fixtures.test-utils.ts'
import { changesOf, evidenceLink } from './history.ts'
import { useHistory } from './useHistory.ts'

const rev = (seq: number, version: number, patch: RevisionEntry['patch']): RevisionEntry => ({
  seq,
  version,
  op: patch.op,
  patch,
  actor: 'p1',
  at: '2026-11-20T10:00:00.000Z',
  cause: null,
})

describe('changesOf', () => {
  const entries = [
    rev(9, 3, { op: 'update', values: { title: 'C', stage: 'done' } }),
    rev(7, 2, { op: 'update', values: { title: 'B' } }),
    rev(4, 1, { op: 'create', folderId: 'bld', values: { title: 'A', points: null } }),
  ]

  it('takes the old value from the nearest older entry that wrote it', () => {
    expect(changesOf(entries, 0)).toEqual([
      { attributeId: 'title', after: 'C', before: { value: 'B' } },
      // Not written since the create, which is loaded: it was empty.
      { attributeId: 'stage', after: 'done', before: { value: undefined } },
    ])
    expect(changesOf(entries, 1)).toEqual([
      { attributeId: 'title', after: 'B', before: { value: 'A' } },
    ])
  })

  it('lists the values a create set, leaving out empty ones', () => {
    expect(changesOf(entries, 2)).toEqual([{ attributeId: 'title', after: 'A', before: null }])
  })

  it('leaves the old value unknown when the create is not loaded', () => {
    expect(changesOf(entries.slice(0, 1), 0)[1]).toEqual({
      attributeId: 'stage',
      after: 'done',
      before: null,
    })
  })

  it('leaves out a clear of a value that was already empty', () => {
    const cleared = [
      rev(9, 2, { op: 'update', values: { stage: null, title: 'B' } }),
      rev(4, 1, { op: 'create', folderId: 'bld', values: { title: 'A' } }),
    ]
    expect(changesOf(cleared, 0).map((c) => c.attributeId)).toEqual(['title'])
    // Unknown before: kept, since it may have held a value.
    expect(changesOf(cleared.slice(0, 1), 0).map((c) => c.attributeId)).toEqual(['stage', 'title'])
  })

  it('has no changes for a delete', () => {
    expect(changesOf([rev(10, 4, { op: 'delete' })], 0)).toEqual([])
  })
})

describe('evidenceLink', () => {
  it('splits http and https URLs into host and the rest', () => {
    expect(evidenceLink('https://github.com/m3di/16bit/pull/220?x=1#a')).toEqual({
      href: 'https://github.com/m3di/16bit/pull/220?x=1#a',
      host: 'github.com',
      rest: '/m3di/16bit/pull/220?x=1#a',
    })
    expect(evidenceLink('http://example.com:8080/')).toMatchObject({
      host: 'example.com:8080',
      rest: '',
    })
  })

  it('never shows user info as the host', () => {
    expect(evidenceLink('https://trusted.com@evil.example/x')?.host).toBe('evil.example')
  })

  it('refuses other schemes and text that is not a URL', () => {
    expect(evidenceLink('javascript:alert(1)')).toBeNull()
    expect(evidenceLink('mailto:a@b.c')).toBeNull()
    expect(evidenceLink('data:text/html,hi')).toBeNull()
    expect(evidenceLink('not a url')).toBeNull()
  })
})

describe('useHistory', () => {
  it('reads the first page newest first', async () => {
    const api = fakeApi(() =>
      json({ items: [rev(4, 1, { op: 'create', folderId: 'b', values: {} })], nextCursor: null }),
    )
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    expect(api.calls[0]?.path).toBe('/v1/workspaces/w/items/i1/revisions?limit=50')
    expect(h.list.value).toMatchObject({ state: 'ready', data: { nextCursor: null } })
    expect(h.newestVersion()).toBe(1)
  })

  it('loads older pages with the cursor and skips entries it already has', async () => {
    const api = fakeApi((call) =>
      call.path.includes('cursor=c1')
        ? json({
            items: [
              rev(7, 2, { op: 'update', values: {} }),
              rev(4, 1, { op: 'create', folderId: 'b', values: {} }),
            ],
            nextCursor: null,
          })
        : json({
            items: [
              rev(9, 3, { op: 'update', values: {} }),
              rev(7, 2, { op: 'update', values: {} }),
            ],
            nextCursor: 'c1',
          }),
    )
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    await h.loadMore()
    const list = h.list.value
    expect(list.state === 'ready' && list.data.entries.map((e) => e.seq)).toEqual([9, 7, 4])
    expect(list.state === 'ready' && list.data.nextCursor).toBeNull()
  })

  it('keeps the entries and reports when an older page fails', async () => {
    let fail = false
    const api = fakeApi(() =>
      fail
        ? json({ error: 'internal', message: 'Down' }, 500)
        : json({ items: [rev(9, 3, { op: 'update', values: {} })], nextCursor: 'c1' }),
    )
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    fail = true
    await h.loadMore()
    expect(h.list.value).toMatchObject({ state: 'ready', data: { more: false, nextCursor: 'c1' } })
    expect(h.list.value.state === 'ready' && h.list.value.data.moreError?.status).toBe(500)
  })

  it('puts newer entries on top after the item changed', async () => {
    let newest = 7
    const api = fakeApi(() =>
      json({
        items: [
          ...(newest > 7 ? [rev(12, 3, { op: 'update', values: {} })] : []),
          rev(7, 2, { op: 'update', values: {} }),
        ],
        nextCursor: 'c1',
      }),
    )
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    newest = 12
    await h.refresh()
    const list = h.list.value
    expect(list.state === 'ready' && list.data.entries.map((e) => e.seq)).toEqual([12, 7])
    expect(list.state === 'ready' && list.data.nextCursor).toBe('c1')
  })

  it('reports a failed refresh without dropping the entries', async () => {
    let fail = false
    const api = fakeApi(() =>
      fail
        ? json({ error: 'internal', message: 'Down' }, 500)
        : json({ items: [rev(7, 2, { op: 'update', values: {} })], nextCursor: null }),
    )
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    fail = true
    await h.refresh()
    const list = h.list.value
    expect(list.state === 'ready' && list.data.entries).toHaveLength(1)
    expect(list.state === 'ready' && list.data.refreshError?.status).toBe(500)
  })

  it('shows a 404 as an error the block turns into not found', async () => {
    const api = fakeApi(() => json({ error: 'not_found', message: 'Not found' }, 404))
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    expect(h.list.value.state === 'error' && h.list.value.error.isNotFound).toBe(true)
  })
})
