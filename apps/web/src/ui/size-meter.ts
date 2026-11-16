export const SIZE_LEVELS = 4

/**
 * How many of the four size squares are filled for an item count (docs/DESIGN.md):
 * 1 under 10 items, 2 under 100, 3 under 1,000, 4 at 1,000 or more.
 * Zero and invalid counts fall in the first band, as "under 10".
 */
export function sizeLevel(count: number): 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count < 10) return 1
  if (count < 100) return 2
  if (count < 1000) return 3
  return 4
}
