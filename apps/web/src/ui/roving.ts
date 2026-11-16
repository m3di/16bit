/**
 * Roving focus for a toolbar (WAI-ARIA toolbar pattern): arrow keys move between controls and
 * wrap, Home and End jump to the ends. Returns the index to focus, or null for other keys.
 */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
