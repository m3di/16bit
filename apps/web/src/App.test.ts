import { createSSRApp } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import App from './App.vue'
import { makeRouter } from './router.ts'
import { createSession, sessionKey } from './session/session.ts'

describe('web', () => {
  it('renders the home route', async () => {
    const router = makeRouter(createMemoryHistory())
    const session = createSession(() => Promise.reject(new Error('no network in render tests')))
    const app = createSSRApp(App).provide(sessionKey, session).use(router)
    await router.push('/')
    await router.isReady()
    const html = await renderToString(app)
    expect(html).toContain('16bit.info')
    expect(html).toContain('<h1')
    expect(html).toContain('Loading workspaces')
  })

  it('routes a hub, with an optional folder', () => {
    const router = makeRouter(createMemoryHistory())
    expect(router.resolve('/w/w1/hubs/h1').params).toMatchObject({ workspaceId: 'w1', hubId: 'h1' })
    expect(router.resolve('/w/w1/hubs/h1/f1').params).toMatchObject({ folderId: 'f1' })
  })

  it('serves the component kit in development', () => {
    const router = makeRouter(createMemoryHistory())
    expect(router.hasRoute('kit')).toBe(import.meta.env.DEV)
  })
})
