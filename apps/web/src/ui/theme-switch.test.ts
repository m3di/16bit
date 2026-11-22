// @vitest-environment client-node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { findAll, fire, mount, type FakeNode } from '../test/fake-dom.ts'

// ThemeSwitch is one icon button (issue 241): it names and shows the theme a click moves to.

function stubBrowser({ stored = null as string | null, dark = false } = {}) {
  const store = new Map<string, string>()
  if (stored !== null) store.set('16bit.theme', stored)
  const classes = new Set<string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    matchMedia: () => ({ matches: dark, addEventListener: () => undefined }),
  })
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        add: (...c: string[]) => {
          c.forEach((x) => classes.add(x))
        },
        remove: (...c: string[]) => {
          c.forEach((x) => classes.delete(x))
        },
      },
    },
  })
  return { store, htmlClass: () => [...classes].join(' ') }
}

async function mountSwitch() {
  vi.resetModules()
  const { startTheme } = await import('../theme/theme.ts')
  const { default: ThemeSwitch } = await import('./ThemeSwitch.vue')
  startTheme()
  const view = mount(ThemeSwitch, {})
  const button = view.get('button')
  const glyph = () => findAll(button, (n: FakeNode) => n.tag === 'svg')[0]?.props['data-glyph']
  return { button, glyph }
}

describe('ThemeSwitch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a native button with a moon in light mode', async () => {
    stubBrowser({ dark: false })
    const { button, glyph } = await mountSwitch()
    expect(button.props['type']).toBe('button')
    expect(button.props['aria-label']).toBe('Switch to dark theme')
    expect(button.props['aria-pressed']).toBeUndefined()
    expect(glyph()).toBe('moon')
  })

  it('shows a sun in dark mode, following the system with no saved choice', async () => {
    stubBrowser({ dark: true })
    const { button, glyph } = await mountSwitch()
    expect(button.props['aria-label']).toBe('Switch to light theme')
    expect(glyph()).toBe('sun')
  })

  it('a click switches the theme, the icon, and the name at once, and saves the choice', async () => {
    const b = stubBrowser({ dark: false })
    const { button, glyph } = await mountSwitch()

    fire(button, 'click')
    await nextTick()
    expect(b.htmlClass()).toBe('theme-dark')
    expect(b.store.get('16bit.theme')).toBe('dark')
    expect(button.props['aria-label']).toBe('Switch to light theme')
    expect(glyph()).toBe('sun')

    fire(button, 'click')
    await nextTick()
    expect(b.htmlClass()).toBe('theme-light')
    expect(b.store.get('16bit.theme')).toBe('light')
    expect(glyph()).toBe('moon')
  })
})
