import type { RootViewMode } from '../root-view/useRootView.ts'

/**
 * When the hub page reads the open folder's items: only today's folder screen shows them (D76),
 * but which screen a folder gets is known only once its view is read. So while the view loads,
 * the items are read alongside it, and a folder with no stored view is no slower than before
 * views existed. `mayHaveItems` says no for a views-only folder, one this page has seen with a
 * stored view, or a folder not yet known; those wait for the view.
 *
 * Returns the function to call with the open folder and the view's mode whenever either changes.
 */
export function folderItemsOpener(
  open: (folderId: string) => void,
  mayHaveItems: (folderId: string) => boolean,
) {
  let shown: { id: string; mode: RootViewMode } | null = null
  // The folder whose items were read while its view was still loading.
  let early: string | null = null
  return (id: string, mode: RootViewMode) => {
    const before = shown
    shown = { id, mode }
    if (before?.id !== id) early = null
    if (mode === 'loading') {
      if (early !== id && mayHaveItems(id)) {
        early = id
        open(id)
      }
      return
    }
    if (mode === 'default') {
      // Already read while the view loaded.
      if (early === id) {
        early = null
        return
      }
      if (before?.id !== id || before.mode !== 'default') open(id)
      return
    }
    early = null
  }
}
