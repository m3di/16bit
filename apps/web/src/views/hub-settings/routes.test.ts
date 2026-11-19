import { createMemoryHistory } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { makeRouter } from '../../router.ts'

describe('hub settings routes', () => {
  const router = makeRouter(createMemoryHistory())

  it('opens each section by name', () => {
    expect(router.resolve('/w/w1/hubs/h1/settings/general').name).toBe('hub-settings-general')
    expect(router.resolve('/w/w1/hubs/h1/settings/access').name).toBe('hub-settings-access')
    expect(router.resolve('/w/w1/hubs/h1/settings/folders').name).toBe('hub-settings-folders')
    expect(router.resolve('/w/w1/hubs/h1/settings/attributes').name).toBe('hub-settings-attributes')
    expect(router.resolve('/w/w1/hubs/h1/settings/agent-keys').name).toBe('hub-settings-keys')
    expect(router.resolve('/w/w1/hubs/h1/settings/danger').name).toBe('hub-settings-danger')
  })

  it('passes the section to the page', () => {
    const to = router.resolve('/w/w1/hubs/h1/settings/agent-keys')
    const props = to.matched[0]?.props['default']
    expect(typeof props === 'function' ? props({ ...to, name: to.name ?? '' }) : null).toEqual({
      workspaceId: 'w1',
      hubId: 'h1',
      section: 'keys',
    })
  })

  it('leaves a folder whose ID is "settings" reachable on the hub route', () => {
    const to = router.resolve('/w/w1/hubs/h1/settings')
    expect(to.name).toBe('hub')
    expect(to.params['folderId']).toBe('settings')
  })
})
