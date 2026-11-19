import { createMemoryHistory } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { makeRouter } from '../../router.ts'

describe('hub settings routes', () => {
  const router = makeRouter(createMemoryHistory())

  it('opens each section by name', () => {
    expect(router.resolve('/w/w1/hubs/h1/settings/folders').name).toBe('hub-settings-folders')
    expect(router.resolve('/w/w1/hubs/h1/settings/attributes').name).toBe('hub-settings-attributes')
  })

  it('leaves a folder whose ID is "settings" reachable on the hub route', () => {
    const to = router.resolve('/w/w1/hubs/h1/settings')
    expect(to.name).toBe('hub')
    expect(to.params['folderId']).toBe('settings')
  })
})
