import type { PaletteColor } from './palette.ts'

export interface ChipOption {
  id: string
  label: string
  color?: PaletteColor | undefined
}

export interface Chip {
  id: string
  label: string
  /** Null for options that have no colour and for values whose option was deleted. */
  color: PaletteColor | null
  /** The value names an option that no longer exists. */
  missing: boolean
}

/**
 * The chips for a multi-select value, in the value's order. Duplicate IDs show once. Values
 * whose option was deleted still show, marked missing, so nothing disappears silently. With a
 * limit, the rest are counted in `overflow` instead of shown.
 */
export function chipsFor(
  value: readonly string[],
  options: readonly ChipOption[],
  limit = Infinity,
): { chips: Chip[]; overflow: number } {
  const byId = new Map(options.map((o) => [o.id, o]))
  const all = [...new Set(value)].map((id): Chip => {
    const option = byId.get(id)
    return option
      ? { id, label: option.label, color: option.color ?? null, missing: false }
      : { id, label: 'Deleted option', color: null, missing: true }
  })
  const shown = Math.max(0, Math.min(all.length, limit))
  return { chips: all.slice(0, shown), overflow: all.length - shown }
}
