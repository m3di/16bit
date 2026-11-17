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
})
