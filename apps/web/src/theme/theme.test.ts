import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import indexHtml from '../../index.html?raw'
import { parsePreference, resolveTheme, THEME_STORAGE_KEY } from './theme.ts'

describe('theme', () => {
  it('follows the system only when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('reads unknown stored values as system', () => {
    expect(parsePreference('dark')).toBe('dark')
    expect(parsePreference('light')).toBe('light')
    expect(parsePreference(null)).toBe('system')
    expect(parsePreference('blue')).toBe('system')
  })
})

/** A minimal browser: <html> class list, localStorage, and a controllable dark-mode query. */
function fakeBrowser({ stored = null as string | null, dark = false, blocked = false } = {}) {
  const store = new Map<string, string>()
  if (stored !== null) store.set(THEME_STORAGE_KEY, stored)
  const blockedFn = () => {
    throw new DOMException('blocked', 'SecurityError')
  }
  const localStorage = blocked
    ? { getItem: blockedFn, setItem: blockedFn, removeItem: blockedFn }
    : {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v)
        },
        removeItem: (k: string) => {
          store.delete(k)
        },
      }

  const listeners = new Set<() => void>()
  const media = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => {
      listeners.add(fn)
    },
  }
  const setSystemDark = (value: boolean) => {
    media.matches = value
    for (const fn of listeners) fn()
  }

  const classes = new Set<string>(['theme-light'])
  const documentElement = {
    classList: {
      add: (...c: string[]) => {
        c.forEach((x) => classes.add(x))
      },
      remove: (...c: string[]) => {
        c.forEach((x) => classes.delete(x))
      },
    },
    get className() {
      return [...classes].join(' ')
    },
    set className(value: string) {
      classes.clear()
      value
        .split(/\s+/)
        .filter(Boolean)
        .forEach((x) => classes.add(x))
    },
  }

  const matchMedia = () => media
  vi.stubGlobal('window', { localStorage, matchMedia })
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('matchMedia', matchMedia)
  vi.stubGlobal('document', { documentElement })

  return {
    store,
    setSystemDark,
    htmlClass: () => documentElement.className,
    listenerCount: () => listeners.size,
  }
}

async function freshTheme() {
  vi.resetModules()
  return import('./theme.ts')
}

describe('startTheme', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('applies a stored dark choice to <html> at start', async () => {
    const b = fakeBrowser({ stored: 'dark', dark: false })
    const { startTheme, useTheme } = await freshTheme()
    startTheme()
    expect(b.htmlClass()).toBe('theme-dark')
    expect(useTheme().preference.value).toBe('dark')
  })

  it('follows the system when nothing is stored', async () => {
    const b = fakeBrowser({ dark: true })
    const { startTheme, useTheme } = await freshTheme()
    startTheme()
    expect(b.htmlClass()).toBe('theme-dark')
    expect(useTheme().preference.value).toBe('system')
  })

  it('stores light and dark, and removes the key for system', async () => {
    const b = fakeBrowser()
    const { startTheme, useTheme } = await freshTheme()
    startTheme()
    const { preference } = useTheme()

    preference.value = 'dark'
    await nextTick()
    expect(b.store.get(THEME_STORAGE_KEY)).toBe('dark')
    expect(b.htmlClass()).toBe('theme-dark')

    preference.value = 'light'
    await nextTick()
    expect(b.store.get(THEME_STORAGE_KEY)).toBe('light')
    expect(b.htmlClass()).toBe('theme-light')

    preference.value = 'system'
    await nextTick()
    expect(b.store.has(THEME_STORAGE_KEY)).toBe(false)
  })

  it('re-syncs on a system change only while the choice is system', async () => {
    const b = fakeBrowser({ dark: false })
    const { startTheme, useTheme } = await freshTheme()
    startTheme()

    b.setSystemDark(true)
    expect(b.htmlClass()).toBe('theme-dark')

    useTheme().preference.value = 'light'
    await nextTick()
    b.setSystemDark(false)
    b.setSystemDark(true)
    expect(b.htmlClass()).toBe('theme-light')
    expect(useTheme().theme.value).toBe('light')
  })

  it('keeps working when storage is blocked', async () => {
    const b = fakeBrowser({ blocked: true, dark: true })
    const { startTheme, useTheme } = await freshTheme()
    expect(() => {
      startTheme()
    }).not.toThrow()
    expect(b.htmlClass()).toBe('theme-dark')

    useTheme().preference.value = 'light'
    await nextTick()
    expect(b.htmlClass()).toBe('theme-light')
  })

  it('starts only once', async () => {
    const b = fakeBrowser({ dark: false })
    const { startTheme } = await freshTheme()
    startTheme()
    startTheme()
    expect(b.listenerCount()).toBe(1)
  })
})

describe('index.html boot script', () => {
  const script = /<script id="theme-boot">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? ''
  afterEach(() => vi.unstubAllGlobals())

  it('exists', () => {
    expect(script).toContain(`'${THEME_STORAGE_KEY}'`)
  })

  it.each([
    [{ stored: 'dark', dark: false }, 'theme-dark'],
    [{ stored: 'light', dark: true }, 'theme-light'],
    [{ stored: null, dark: true }, 'theme-dark'],
    [{ stored: 'blue', dark: false }, 'theme-light'],
    [{ blocked: true, dark: true }, 'theme-dark'],
  ])('sets the theme before first paint for %o', (opts, expected) => {
    const b = fakeBrowser(opts)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const boot = new Function(script) as () => void
    boot()
    expect(b.htmlClass()).toBe(expected)
  })
})
