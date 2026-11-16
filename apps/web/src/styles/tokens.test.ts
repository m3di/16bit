import { describe, expect, it } from 'vitest'
import { PALETTE } from '../ui/palette.ts'
import css from './tokens.css?raw'

type Vars = Record<string, string>

function themeVars(name: 'light' | 'dark'): Vars {
  const block = new RegExp(`\\.theme-${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  const vars: Vars = {}
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    vars[m[1] as string] = (m[2] as string).toLowerCase()
  }
  return vars
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT = 4.5
const NON_TEXT = 3
const textTokens = ['ink', 'ink2', 'ink3', 'accent', 'success', 'warning', 'danger']
const surfaces = ['bg', 'surface', 'selected']
// Base palette values fixed by docs/DESIGN.md that are below 3:1 on the light background.
// They are decorative next to a text label. Raised with the maintainer on #8.
const lowContrastBase: Record<string, string[]> = { light: ['yellow', 'grey'], dark: [] }

describe.each(['light', 'dark'] as const)('%s theme tokens', (name) => {
  const v = themeVars(name)
  const get = (token: string): string => {
    const value = v[token]
    if (!value) throw new Error(`--${token} is missing from .theme-${name}`)
    return value
  }

  it('defines the same tokens as the other theme', () => {
    const other = themeVars(name === 'light' ? 'dark' : 'light')
    expect(Object.keys(v).sort()).toEqual(Object.keys(other).sort())
  })

  it.each(textTokens.flatMap((t) => surfaces.map((s) => [t, s])))(
    '--%s text on --%s is at least 4.5:1',
    (text, surface) => {
      expect(contrast(get(text), get(surface))).toBeGreaterThanOrEqual(TEXT)
    },
  )

  it('text on an accent fill is at least 4.5:1', () => {
    expect(contrast(get('on-accent'), get('accent'))).toBeGreaterThanOrEqual(TEXT)
  })

  it.each([...PALETTE])('%s chip ink is readable on its tint and on the page', (color) => {
    const ink = get(`pal-${color}-ink`)
    for (const bg of [get(`pal-${color}-tint`), get('bg'), get('surface')]) {
      expect(contrast(ink, bg)).toBeGreaterThanOrEqual(TEXT)
    }
  })

  it('status dots and the focus ring are at least 3:1 on the page', () => {
    for (const t of ['accent', 'success', 'warning', 'danger', 'ink3']) {
      expect(contrast(get(t), get('bg'))).toBeGreaterThanOrEqual(NON_TEXT)
    }
  })

  it('lists exactly the palette colours below 3:1 on the page', () => {
    const low = PALETTE.filter((c) => contrast(get(`pal-${c}`), get('bg')) < NON_TEXT)
    expect(low).toEqual(lowContrastBase[name])
  })
})
