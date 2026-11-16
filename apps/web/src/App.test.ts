import { createSSRApp } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import App from './App.vue'
import { makeRouter } from './router.ts'

describe('web', () => {
  it('renders the home route', async () => {
    const router = makeRouter(createMemoryHistory())
    const app = createSSRApp(App).use(router)
    await router.push('/')
    await router.isReady()
    const html = await renderToString(app)
    expect(html).toContain('16bit.info')
    expect(html).toContain('<h1')
    expect(html).toContain('Loading workspaces')
  })

  it('serves the component kit in development', () => {
    const router = makeRouter(createMemoryHistory())
    expect(router.hasRoute('kit')).toBe(import.meta.env.DEV)
  })
})
