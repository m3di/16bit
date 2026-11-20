// Logic for DataTable's virtual mode, kept apart from the component so it can be tested alone.

/** Every row of a virtual table is this high, borders included (`docs/DESIGN.md`). */
export const VIRTUAL_ROW_HEIGHT = 38

/** The sticky header row of a virtual table, the same as in select mode. */
export const VIRTUAL_HEADER_HEIGHT = 36

/** Rows loaded per request, as in D61. */
export const DEFAULT_WINDOW_SIZE = 200

/** Rows rendered above and below the visible ones, so a quick scroll does not show gaps. */
export const VIRTUAL_OVERSCAN = 8

/**
 * The rows a virtual table has rendered, from `start` up to but not including `end`, and the
 * offsets of the windows that hold them. The screen loads the windows it does not have yet.
 */
export interface RowWindows {
  start: number
  end: number
  offsets: number[]
}

/** The offsets of the windows of `size` rows that cover rows `start` to `end` (exclusive). */
export function windowOffsets(start: number, end: number, size: number): number[] {
  if (end <= start || size <= 0) return []
  const first = Math.floor(start / size) * size
  const offsets: number[] = []
  for (let offset = first; offset < end; offset += size) offsets.push(offset)
  return offsets
}

export const sameWindows = (a: RowWindows | null, b: RowWindows) =>
  a !== null &&
  a.offsets.length === b.offsets.length &&
  a.offsets.every((offset, i) => offset === b.offsets[i])

/**
 * The row index a key moves the selection to, or null for other keys. Up and Down move one row
 * and stop at the ends (a table does not wrap), Page Up and Page Down move by `page` rows, and
 * Home and End jump. With nothing selected (`current` -1), Down and Page Down start at the
 * first row and Up and Page Up at the last.
 */
export function rowKeyIndex(
  current: number,
  key: string,
  count: number,
  page: number,
): number | null {
  if (count <= 0) return null
  const last = count - 1
  const clamp = (i: number) => Math.min(last, Math.max(0, i))
  const step = Math.max(1, page)
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : clamp(current + 1)
    case 'ArrowUp':
      return current < 0 ? last : clamp(current - 1)
    case 'PageDown':
      return current < 0 ? 0 : clamp(current + step)
    case 'PageUp':
      return current < 0 ? last : clamp(current - step)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}
