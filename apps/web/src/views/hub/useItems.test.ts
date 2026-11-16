import type { Item } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { fakeApi, item, json, type Call } from './fixtures.test-utils.ts'
import { inHub, useItems, valueErrors } from './useItems.ts'

const page = (items: Item[], nextCursor: string | null = null) => json({ items, nextCursor })

/** A promise that resolves when `release` is called, to hold a request open. */
function gate<T>() {
  let release: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function opened(handler: (call: Call) => Response | Promise<Response>, items: Item[]) {
  const api = fakeApi((call) => (call.path.endsWith('/query') ? page(items) : handler(call)))
  const s = useItems('w', () => 'BLD', api.fetchFn)
  await s.openFolder('bld')
  return { s, calls: api.calls }
}

describe('useItems: reading', () => {
  it('queries the folder and keeps the server order', async () => {
    const { s, calls } = await opened(() => json({}), [item('i2', 2), item('i1', 1)])
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/workspaces/w/query',
      body: { from: 'bld', limit: 50, cursor: null },
    })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i2', 'i1'])
  })

  it('loads more with the cursor and skips duplicates', async () => {
    const api = fakeApi((call) => {
      const body = call.body as { cursor: string | null }
      return body.cursor === 'c1'
        ? page([item('i2', 2), item('i3', 3)])
        : page([item('i1', 1), item('i2', 2)], 'c1')
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.loadMore()
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1', 'i2', 'i3'])
    expect(s.list.value).toMatchObject({ state: 'ready', data: { nextCursor: null } })
  })

  it('shows an error state, and no permission for a refused key', async () => {
    const api = fakeApi(() => json({ error: 'unauthorized', message: 'No' }, 401))
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    expect(s.list.value).toMatchObject({ state: 'error', error: { isNoPermission: true } })
  })

  it('ignores a slower answer for a folder that is no longer open', async () => {
    const slow = gate<Response>()
    const api = fakeApi((call) =>
      (call.body as { from: string }).from === 'old' ? slow.promise : page([item('new', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    const first = s.openFolder('old')
    await s.openFolder('new')
    slow.release(page([item('old', 2)]))
    await first
    expect(s.rows.value.map((r) => r.id)).toEqual(['new'])
  })

  it('fetches an item that is not in the list', async () => {
    const { s, calls } = await opened(() => json(item('far', 99)), [])
    expect(await s.openItem('far')).toMatchObject({ state: 'ready', data: { seqId: 99 } })
    expect(calls.at(-1)?.path).toBe('/v1/workspaces/w/items/far')
    expect(s.view('far')?.seqId).toBe(99)
  })
})

describe('useItems: editing', () => {
  it('shows an edit at once, then takes the server version', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1, { title: 'Old' })])
    const saved = s.save('i1', { title: 'New' })
    expect(s.view('i1')?.values['title']).toBe('New')
    expect(s.isSaving('i1')).toBe(true)
    answer.release(json(item('i1', 1, { title: 'New' }, 2)))
    expect(await saved).toBe(true)
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/v1/workspaces/w/items/i1',
      body: { version: 1, values: { title: 'New' } },
    })
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'New' } })
    expect(s.isSaving('i1')).toBe(false)
  })

  it('rolls back to the current item on 409 and says so', async () => {
    const current = item('i1', 7, { title: 'Theirs' }, 3)
    const { s } = await opened(
      () => json({ error: 'conflict', message: 'Changed', current }, 409),
      [item('i1', 7, { title: 'Old' })],
    )
    const saved = s.save('i1', { title: 'Mine' })
    expect(s.view('i1')?.values['title']).toBe('Mine')
    expect(await saved).toBe(false)
    expect(s.view('i1')).toMatchObject({ version: 3, values: { title: 'Theirs' } })
    expect(s.notice.value).toContain('BLD-7 was changed by someone else')
  })

  it('drops queued edits after a conflict', async () => {
    const current = item('i1', 1, { title: 'Theirs' }, 3)
    const { s, calls } = await opened(
      () => json({ error: 'conflict', message: 'Changed', current }, 409),
      [item('i1', 1, { title: 'Old' })],
    )
    const results = await Promise.all([s.save('i1', { title: 'A' }), s.save('i1', { points: 2 })])
    expect(results).toEqual([false, false])
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    expect(s.view('i1')?.values).toEqual({ title: 'Theirs' })
  })

  it('rolls back any other rejection with the server message', async () => {
    const { s } = await opened(
      () => json({ error: 'invalid_values', message: 'Some values are not valid' }, 422),
      [item('i1', 1, { title: 'Old' })],
    )
    expect(await s.save('i1', { title: '' })).toBe(false)
    expect(s.view('i1')?.values['title']).toBe('Old')
    expect(s.notice.value).toBe('Your change to BLD-1 was not saved. Some values are not valid')
    s.dismissNotice()
    expect(s.notice.value).toBeNull()
  })

  it('sends quick edits one after another, each with the latest version', async () => {
    let version = 1
    const { s, calls } = await opened(
      (call) => {
        const body = call.body as { values: Item['values'] }
        version++
        return json(item('i1', 1, body.values, version))
      },
      [item('i1', 1)],
    )
    await Promise.all([s.save('i1', { title: 'A' }), s.save('i1', { points: 2 })])
    expect(
      calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { version: number }).version),
    ).toEqual([1, 2])
  })
})

describe('useItems: creating', () => {
  it('adds the row at once and keeps it when the server confirms', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1)])
    const created = s.create({ title: 'Fresh' })
    const id = s.rows.value[0]?.id ?? ''
    expect(s.rows.value).toHaveLength(2)
    expect(s.isCreating(id)).toBe(true)
    const body = calls.at(-1)?.body as { id: string; folderId: string; values: unknown }
    expect(body).toEqual({ id, folderId: 'bld', values: { title: 'Fresh' } })
    answer.release(json(item(id, 2, { title: 'Fresh' }), 201))
    expect(await created).toMatchObject({ ok: true, item: { id, seqId: 2 } })
    expect(s.isCreating(id)).toBe(false)
    expect(s.rows.value.map((r) => r.seqId)).toEqual([2, 1])
  })

  it('removes the row and reports field errors when the server refuses', async () => {
    const { s } = await opened(
      () =>
        json(
          {
            error: 'invalid_values',
            message: 'Some values are not valid',
            errors: [{ attributeId: 'title', code: 'required', message: 'A value is required' }],
          },
          422,
        ),
      [item('i1', 1)],
    )
    const result = await s.create({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(valueErrors(result.error)).toEqual({ title: 'A value is required' })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
    expect(s.notice.value).toContain('The item was not created')
  })

  it('does not send an edit for an item the server has not confirmed', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1)])
    const created = s.create({ title: 'Fresh' })
    const id = s.rows.value[0]?.id ?? ''
    const sent = calls.length
    expect(await s.save(id, { title: 'Edited' })).toBe(false)
    expect(calls).toHaveLength(sent)
    expect(s.view(id)?.values).toEqual({ title: 'Fresh' })
    expect(s.notice.value).toContain('still being saved')
    answer.release(json(item(id, 2, { title: 'Fresh' }), 201))
    await created
  })
})

describe('inHub', () => {
  it('passes an item of this hub through', () => {
    const ready = { state: 'ready' as const, data: item('i1', 1) }
    expect(inHub(ready, 'bld')).toBe(ready)
  })

  it('reports an item of another hub as missing', () => {
    const other = { state: 'ready' as const, data: { ...item('i1', 1), hubId: 'ops' } }
    expect(inHub(other, 'bld')).toMatchObject({ state: 'error', error: { status: 404 } })
  })
})
