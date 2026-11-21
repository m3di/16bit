import { describe, expect, it } from 'vitest'
import { FolderRows } from './folder-rows.ts'

const window = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`)

describe('FolderRows (D61)', () => {
  it('holds loaded windows by position, with holes elsewhere', () => {
    const rows = new FolderRows()
    rows.put(0, window('a', 200), 50_000)
    expect(rows.total).toBe(50_000)
    expect(rows.hasWindow(0)).toBe(true)
    expect(rows.hasWindow(200)).toBe(false)
    rows.put(49_800, window('z', 200), 50_000)
    expect(rows.hasWindow(49_800)).toBe(true)
    expect(rows.ids[49_999]).toBe('z199')
    expect(rows.indexOf('z0')).toBe(49_800)
    expect(rows.indexOf('missing')).toBe(-1)
  })

  it('counts the last window loaded when it is short', () => {
    const rows = new FolderRows()
    rows.put(0, window('a', 30), 30)
    expect(rows.hasWindow(0)).toBe(true)
  })

  it('shifts later rows when a row is added or removed, and finds them again', () => {
    const rows = new FolderRows()
    rows.put(0, ['a', 'b', 'c'], 5)
    rows.insertAt(0, 'new')
    expect(rows.total).toBe(6)
    expect(rows.ids.slice(0, 4)).toEqual(['new', 'a', 'b', 'c'])
    expect(rows.indexOf('c')).toBe(3)
    rows.removeAt(rows.indexOf('a'))
    expect(rows.total).toBe(5)
    expect(rows.indexOf('c')).toBe(2)
    expect(rows.hasWindow(0, 3)).toBe(true)
    // Rows not loaded move too: the window past them is not complete.
    expect(rows.hasWindow(0)).toBe(false)
  })

  it('keeps an item at one row when a later read finds it moved', () => {
    const rows = new FolderRows()
    rows.put(0, ['a', 'b'], 4)
    rows.put(2, ['b', 'c'], 4)
    expect([...rows.ids]).toEqual(['a', undefined, 'b', 'c'])
    expect(rows.indexOf('b')).toBe(2)
  })

  it('follows a smaller total', () => {
    const rows = new FolderRows()
    rows.put(0, ['a', 'b', 'c'], 3)
    rows.put(0, ['a'], 1)
    expect(rows.total).toBe(1)
    expect(rows.indexOf('c')).toBe(-1)
  })
})
