import { describe, expect, it } from 'vitest'
import { description, fakeApi, json } from './fixtures.test-utils.ts'
import { useHubDirectory } from './useHubDirectory.ts'

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('useHubDirectory', () => {
  it('reads each hub once and keeps a hidden one as an error', async () => {
    const api = fakeApi((call) =>
      call.path.endsWith('/hubs/other')
        ? json({ ...description, hub: { ...description.hub, id: 'other' } })
        : json({ error: 'not_found', message: 'Not found' }, 404),
    )
    const d = useHubDirectory('w', api.fetchFn)
    d.seed(description)
    d.ensure(['bld', 'other', 'hidden', 'other'])
    expect(d.lookup('other')).toBe('loading')
    await settle()
    expect(api.calls.map((c) => c.path)).toEqual([
      '/v1/workspaces/w/hubs/other',
      '/v1/workspaces/w/hubs/hidden',
    ])
    expect(d.lookup('bld')).toEqual(description)
    expect(d.lookup('other')).toMatchObject({ hub: { id: 'other' } })
    expect(d.lookup('hidden')).toBe('error')
    d.retry('hidden')
    await settle()
    expect(api.calls).toHaveLength(3)
  })

  it('settles a refresh only once its answer is applied', async () => {
    let answer: (r: Response) => void = () => undefined
    const fetchFn = () =>
      new Promise<Response>((resolve) => {
        answer = resolve
      })
    const d = useHubDirectory('w', fetchFn)
    d.seed(description)
    let done = false
    const read = d.refresh('bld').then(() => {
      done = true
    })
    await settle()
    expect(done).toBe(false)
    const renamed = { ...description, hub: { ...description.hub, name: 'Renamed' } }
    answer(json(renamed))
    await read
    expect(d.lookup('bld')).toMatchObject({ hub: { name: 'Renamed' } })
    // An unknown hub has nothing to read again.
    await expect(d.refresh('unknown')).resolves.toBeUndefined()
  })
})
