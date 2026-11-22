import { ref, watch, type Ref } from 'vue'

export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

export const THEME_STORAGE_KEY = '16bit.theme'
export const THEME_CLASS: Record<Theme, string> = { light: 'theme-light', dark: 'theme-dark' }

export function parsePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/** The theme a click on the switch moves to: always the opposite of the one shown. */
export function oppositeTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

export function applyTheme(el: Element, theme: Theme): void {
  el.classList.remove(THEME_CLASS.light, THEME_CLASS.dark)
  el.classList.add(THEME_CLASS[theme])
}

const preference = ref<ThemePreference>('system')
const theme = ref<Theme>('light')
let started = false

/**
 * Starts the app-wide theme: reads the stored choice, follows the system setting when the choice
 * is "system", and keeps the theme class on <html> in sync. Safe to call more than once.
 */
export function startTheme(): void {
  if (started || typeof window === 'undefined') return
  started = true

  const media = window.matchMedia('(prefers-color-scheme: dark)')
  preference.value = parsePreference(readStored())

  const sync = () => {
    theme.value = resolveTheme(preference.value, media.matches)
    applyTheme(document.documentElement, theme.value)
  }
  sync()
  media.addEventListener('change', sync)
  watch(preference, (value) => {
    writeStored(value)
    sync()
  })
}

/**
 * Switches to the opposite of the theme shown and saves it. With no saved choice the theme follows
 * the system until this first runs; afterwards the choice is explicit (issue 241).
 */
export function toggleTheme(): void {
  preference.value = oppositeTheme(theme.value)
}

export function useTheme(): {
  preference: Ref<ThemePreference>
  theme: Readonly<Ref<Theme>>
  toggle: () => void
} {
  return { preference, theme, toggle: toggleTheme }
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(value: ThemePreference): void {
  try {
    if (value === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // Storage can be blocked. The choice then lasts for this page only.
  }
}
