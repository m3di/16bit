// @vitest-environment client-node
import { defineComponent, h, nextTick, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { activeElement, findAll, fire, mount, type FakeNode } from '../test/fake-dom.ts'
import type { RowWindows } from './data-table.ts'
import DataTable, { type TableColumn } from './DataTable.vue'

type Row = { id: string; title: string }
const columns: TableColumn[] = [
  { key: 'title', label: 'Title' },
  { key: 'stage', label: 'Stage', sort: 'none' },
]

function setup(rowCount = 1000, loaded = 50) {
  const state = reactive({
    store: new Map<number, Row>(),
    selectedId: null as string | null,
  })
  for (let i = 0; i < loaded; i++)
    state.store.set(i, { id: `r${String(i)}`, title: `Row ${String(i)}` })
  const selected: Row[] = []
  const windows: RowWindows[] = []
  const sorted: string[] = []
  const Host = defineComponent({
    render: () =>
      h(
        DataTable<Row>,
        {
          caption: 'Items',
          columns,
          mode: 'virtual',
          rowCount,
          height: 400,
          selectedId: state.selectedId,
          rowAt: (i: number) => state.store.get(i),
          onSelect: (row: Row) => {
            selected.push(row)
            state.selectedId = row.id
          },
          onWindows: (w: RowWindows) => windows.push(w),
          onSort: (key: string) => sorted.push(key),
        },
        { cell: ({ row }: { row: Row }) => row.title },
      ),
  })
  const { root } = mount(Host, {})
  const rows = () => findAll(root, (n) => n.tag === 'tr' && 'data-index' in n.props)
  const row = (index: number) => {
    const found = rows().find((r) => r.props['data-index'] === index)
    if (!found) throw new Error(`row ${String(index)} is not rendered`)
    return found
  }
  const text = (n: FakeNode): string => (n.tag === '#text' ? n.text : n.children.map(text).join(''))
  return { root, state, selected, windows, sorted, rows, row, text }
}

const key = (el: FakeNode, k: string) => {
  fire(el, 'keydown', { key: k, currentTarget: el, preventDefault: () => undefined })
}

const box = (root: FakeNode) => {
  const [found] = findAll(root, (n) => n.tag === 'div' && 'data-virtual' in n.props)
  if (!found) throw new Error('no scroll box rendered')
  return found
}

describe('DataTable virtual mode, in use', () => {
  it('renders only the rows in view and asks for the window that holds them', async () => {
    const t = setup(50_000)
    await nextTick()
    // 400px box, 36px header, 38px rows: 10 rows in view and 8 rendered below for a quick scroll.
    expect(t.rows()).toHaveLength(18)
    expect(t.windows).toEqual([{ start: 0, end: 18, offsets: [0] }])
  })

  it('selects a row on click, but not a placeholder or a click on a link', async () => {
    const t = setup(1000, 5)
    await nextTick()
    fire(t.row(2), 'click', { target: t.row(2) })
    expect(t.selected.map((r) => r.id)).toEqual(['r2'])
    fire(t.row(7), 'click', { target: t.row(7) })
    const link = { closest: (s: string) => (s.includes('a') ? {} : null) }
    fire(t.row(3), 'click', { target: link })
    expect(t.selected.map((r) => r.id)).toEqual(['r2'])
  })

  it('moves the selection with Up and Down, and moves focus with it', async () => {
    const t = setup()
    await nextTick()
    key(t.row(0), 'ArrowDown')
    await nextTick()
    expect(t.selected.map((r) => r.id)).toEqual(['r1'])
    expect(activeElement(t.root)).toBe(t.row(1))
    // Keys pressed before the parent re-renders with the new selection still move it.
    key(t.row(1), 'ArrowDown')
    key(t.row(2), 'ArrowUp')
    await nextTick()
    expect(t.selected.map((r) => r.id)).toEqual(['r1', 'r2', 'r1'])
    expect(activeElement(t.root)).toBe(t.row(1))
    // At the top, Up stays put and selects nothing new.
    key(t.row(1), 'Home')
    key(t.row(0), 'ArrowUp')
    expect(t.selected.map((r) => r.id)).toEqual(['r1', 'r2', 'r1', 'r0'])
  })

  it('keeps the tab stop on the selected row, so the table is one stop', async () => {
    const t = setup()
    await nextTick()
    expect(t.rows().filter((r) => r.props['tabindex'] === 0)).toEqual([t.row(0)])
    t.state.selectedId = 'r4'
    await nextTick()
    expect(t.rows().filter((r) => r.props['tabindex'] === 0)).toEqual([t.row(4)])
    expect(t.row(4).props['aria-selected']).toBe('true')
    expect(t.row(0).props['aria-selected']).toBeUndefined()
  })

  it('scrolls a row moved to into view below the sticky header', async () => {
    const t = setup(1000)
    await nextTick()
    t.state.selectedId = 'r9'
    await nextTick()
    // The fake DOM has no layout: give the box the size a browser would.
    Object.assign(box(t.root), { scrollHeight: 36 + 1000 * 38, clientHeight: 400 })
    // Row 10 ends at 36 + 11 * 38 = 454px, past the 400px box: it is aligned to the bottom.
    key(t.row(9), 'ArrowDown')
    expect(box(t.root).scrollTop).toBe(454 - 400)
  })

  it('selects a row that is not loaded yet once it arrives', async () => {
    const t = setup(1000, 50)
    await nextTick()
    key(t.row(0), 'End')
    await nextTick()
    expect(t.selected).toEqual([])
    t.state.store.set(999, { id: 'r999', title: 'Last' })
    await nextTick()
    expect(t.selected.map((r) => r.id)).toEqual(['r999'])
  })

  it('pages by the rows that fit in the box', async () => {
    const t = setup()
    await nextTick()
    key(t.row(0), 'PageDown')
    // 400px less the 36px header holds 9 whole rows; a page keeps one row of context.
    expect(t.selected.map((r) => r.id)).toEqual(['r8'])
  })

  it('leaves keys pressed in a control inside the row to that control', async () => {
    const t = setup()
    await nextTick()
    fire(t.row(0), 'keydown', { key: 'ArrowDown', currentTarget: t.row(0), target: {} })
    expect(t.selected).toEqual([])
  })

  it('still sorts from its header buttons', () => {
    const t = setup()
    const [button] = findAll(t.root, (n) => n.tag === 'button')
    if (!button) throw new Error('no sort button')
    fire(button, 'click')
    expect(t.sorted).toEqual(['stage'])
  })
})
