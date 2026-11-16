import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('web', () => {
  it('renders the app shell', async () => {
    const html = await renderToString(createSSRApp(App))
    expect(html).toContain('16bit.info')
  })
})
