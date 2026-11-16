import type { PaletteColor } from '@16bit/core'

/** The palette names come from @16bit/core (one source of truth). Values live in styles/tokens.css. */
export { PALETTE_COLORS, type PaletteColor } from '@16bit/core'

export type PaletteShade = 'base' | 'tint' | 'ink'

/** CSS variable reference for a palette colour, for inline styles on dynamic colours. */
export function paletteVar(color: PaletteColor, shade: PaletteShade = 'base'): string {
  return shade === 'base' ? `var(--pal-${color})` : `var(--pal-${color}-${shade})`
}
