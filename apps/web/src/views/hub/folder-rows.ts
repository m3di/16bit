// The open folder's rows by position, for the virtual table (D61). A large folder is read in
// windows of 200 rows by offset, so the list is sparse: item IDs where a window was loaded, holes
// elsewhere. A create or delete shifts every later row by one without a read.

/** Rows per window, as in D61. */
export const WINDOW_SIZE = 200

export class FolderRows {
  /** Item IDs by position; holes are rows not loaded. Its length is always `total`. */
  ids: (string | undefined)[]
  /** Positions by ID, rebuilt after a shift. */
  #index: Map<string, number> | null = new Map()

  constructor(total = 0) {
    this.ids = new Array<string | undefined>(total)
  }

  get total() {
    return this.ids.length
  }

  set total(total: number) {
    if (total < this.ids.length) {
      for (const id of this.ids.slice(total)) if (id) this.#index?.delete(id)
    }
    this.ids.length = total
  }

  /** Whether every row of the window at `offset` is loaded. */
  hasWindow(offset: number, size = WINDOW_SIZE): boolean {
    const end = Math.min(offset + size, this.total)
    for (let i = offset; i < end; i++) if (this.ids[i] === undefined) return false
    return true
  }

  #positions(): Map<string, number> {
    if (!this.#index) {
      const index = new Map<string, number>()
      this.ids.forEach((id, i) => {
        if (id) index.set(id, i)
      })
      this.#index = index
    }
    return this.#index
  }

  indexOf(id: string): number {
    return this.#positions().get(id) ?? -1
  }

  /**
   * Puts a window read at `offset`, with the folder's `total` as that read counted it. An ID
   * that is also listed elsewhere, from before a shift, is kept only here.
   */
  put(offset: number, ids: readonly string[], total: number) {
    this.total = Math.max(total, offset + ids.length)
    const index = this.#positions()
    ids.forEach((id, i) => {
      const at = offset + i
      const before = index.get(id)
      if (before !== undefined && before !== at) this.ids[before] = undefined
      const replaced = this.ids[at]
      if (replaced && replaced !== id) index.delete(replaced)
      this.ids[at] = id
      index.set(id, at)
    })
  }

  /** Adds a row at `index`; later rows move down by one. */
  insertAt(index: number, id: string) {
    this.ids.splice(Math.min(index, this.total), 0, id)
    this.#index = null
  }

  /** Removes the row at `index`; later rows move up by one. */
  removeAt(index: number) {
    if (index < 0 || index >= this.total) return
    this.ids.splice(index, 1)
    this.#index = null
  }
}
