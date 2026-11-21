import type { RevisionEntry } from '@16bit/core'
import { describe, expect, it, vi } from 'vitest'
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

  const page = (seqs: number[], nextCursor: string | null = null) =>
    json({ items: seqs.map((seq) => rev(seq, seq, { op: 'update', values: {} })), nextCursor })
  const seqsOf = (h: ReturnType<typeof useHistory>) =>
    h.list.value.state === 'ready' ? h.list.value.data.entries.map((e) => e.seq) : null

  /** A response the test answers when it wants. */
  function deferred() {
    let answer: (r: Response) => void = () => undefined
    const promise = new Promise<Response>((resolve) => (answer = resolve))
    return { promise, answer }
  }

  it('starts again from the first page when more than a page of changes came in', async () => {
    let first = true
    const api = fakeApi(() => {
      const r = first ? page([7], 'c1') : page([14, 13], 'n1')
      first = false
      return r
    })
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    await h.refresh()
    expect(seqsOf(h)).toEqual([14, 13])
    expect(h.list.value.state === 'ready' && h.list.value.data.nextCursor).toBe('n1')
  })

  it('drops a "Show older" on its way when a refresh starts the list again', async () => {
    const older = deferred()
    let reads = 0
    const api = fakeApi((call) => {
      if (call.path.includes('cursor=c1')) return older.promise
      reads++
      return reads === 1 ? page([9, 8], 'c1') : page([12, 11], 'n1')
    })
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    const more = h.loadMore()
    await h.refresh()
    // The old second page arrives after the list was replaced: it would leave a gap.
    older.answer(page([7, 6], null))
    await more
    expect(seqsOf(h)).toEqual([12, 11])
    expect(h.list.value).toMatchObject({ state: 'ready', data: { nextCursor: 'n1', more: false } })
  })

  it('catches up after the first read when the item moved on while it loaded', async () => {
    let reads = 0
    const api = fakeApi(() => (++reads === 1 ? page([4]) : page([5, 4])))
    const h = useHistory('w', 'i1', api.fetchFn, () => 5)
    await h.load()
    expect(seqsOf(h)).toEqual([5, 4])
    expect(reads).toBe(2)
  })

  it('does not read again when the history already holds the item version', async () => {
    const api = fakeApi(() => page([4]))
    const h = useHistory('w', 'i1', api.fetchFn, () => 4)
    await h.load()
    await h.catchUp()
    expect(api.calls).toHaveLength(1)
  })

  it('joins refreshes asked for while one runs into one more read, without duplicates', async () => {
    const answers: ReturnType<typeof deferred>[] = []
    let reads = 0
    const api = fakeApi(() => {
      if (++reads === 1) return page([4])
      const d = deferred()
      answers.push(d)
      return d.promise
    })
    const h = useHistory('w', 'i1', api.fetchFn)
    await h.load()
    const first = h.refresh()
    const second = h.refresh()
    const third = h.refresh()
    await Promise.resolve()
    answers[0]?.answer(page([5, 4]))
    await vi.waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    answers[1]?.answer(page([6, 5, 4]))
    await Promise.all([first, second, third])
    expect(seqsOf(h)).toEqual([6, 5, 4])
    expect(reads).toBe(3)
  })
})
