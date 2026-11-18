/**
 * Roving focus for a toolbar, tab list, or menu (WAI-ARIA patterns): arrow keys along the
 * orientation move between controls and wrap, Home and End jump to the ends. Returns the index
 * to focus, or null for other keys.
 */
export function rovingIndex(
  current: number,
  key: string,
  count: number,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): number | null {
  if (count <= 0) return null
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  switch (key) {
    case next:
      return (current + 1) % count
    case prev:
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
