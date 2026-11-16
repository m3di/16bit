/** The 16-colour palette from docs/DESIGN.md, in display order. Values live in styles/tokens.css. */
export const PALETTE = [
  'indigo',
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'red',
  'pink',
  'magenta',
  'violet',
  'slate',
  'ink',
  'grey',
] as const

export type PaletteColor = (typeof PALETTE)[number]

export type PaletteShade = 'base' | 'tint' | 'ink'

/** CSS variable reference for a palette colour, for inline styles on dynamic colours. */
export function paletteVar(color: PaletteColor, shade: PaletteShade = 'base'): string {
  return shade === 'base' ? `var(--pal-${color})` : `var(--pal-${color}-${shade})`
}
