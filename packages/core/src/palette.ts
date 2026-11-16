import { z } from 'zod'

/** The fixed 16-colour palette (docs/DESIGN.md, D39). Stored data holds the name, never hex. */
export const PALETTE_COLORS = [
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
export type PaletteColor = (typeof PALETTE_COLORS)[number]

export const paletteColorSchema = z.enum(PALETTE_COLORS)
