export const SIZE_LEVELS = 4

/**
 * How many of the four size squares are filled for an item count (docs/DESIGN.md):
 * none at 0 items, 1 for 1 to 9, 2 under 100, 3 under 1,000, 4 at 1,000 or more.
 * Negative and non-finite counts read as empty.
 */
export function sizeLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count < 1) return 0
  if (count < 10) return 1
  if (count < 100) return 2
  if (count < 1000) return 3
  return 4
}
