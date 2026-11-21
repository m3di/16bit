// @vitest-environment client-node
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { activeElement, findAll, fire, mount, setLayout, type FakeNode } from '../test/fake-dom.ts'
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
  const via: string[] = []
  const windows: RowWindows[] = []
  const sorted: string[] = []
  const table = ref<{ isInView: (index: number) => boolean } | null>(null)
  const Host = defineComponent({
    render: () =>
      h(
        DataTable<Row>,
        {
          ref: table,
          caption: 'Items',
          columns,
          rows: [],
          mode: 'virtual',
          rowCount,
          height: 400,
          selectedId: state.selectedId,
          rowAt: (i: number) => state.store.get(i),
          indexOf: (id: string) => {
            for (const [i, row] of state.store) if (row.id === id) return i
            return -1
          },
          onSelect: (row: Row, how: string) => {
            selected.push(row)
            via.push(how)
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
  return { root, state, selected, via, windows, sorted, rows, row, text, table }
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
    // 400px box, 36px header, 38px rows: 10 rows in view and 2 rendered below for a quick scroll.
    expect(t.rows()).toHaveLength(12)
    expect(t.windows).toEqual([{ start: 0, end: 12, offsets: [0] }])
  })

  it('selects a row on click, but not a placeholder or a click on a link', async () => {
    const t = setup(1000, 5)
    await nextTick()
    fire(t.row(2), 'click', { target: t.row(2) })
    expect(t.selected.map((r) => r.id)).toEqual(['r2'])
    expect(t.via).toEqual(['pointer'])
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
    // The screen keeps focus in the table for a selection by keyboard.
    expect(t.via).toEqual(['keyboard'])
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

  it('keeps focus when the placeholder that has it is replaced by its row', async () => {
    const t = setup(1000, 5)
    await nextTick()
    fire(t.row(7), 'focusin')
    t.row(7).focus()
    t.state.store.set(7, { id: 'r7', title: 'Row 7' })
    await nextTick()
    expect(t.row(7).props['data-row']).toBe('')
    expect(activeElement(t.root)).toBe(t.row(7))
  })

  it('moves an element with its row when a row is added above, so focus stays on its item', async () => {
    const t = setup(1000, 10)
    await nextTick()
    key(t.row(0), 'ArrowDown')
    key(t.row(1), 'ArrowDown')
    await nextTick()
    const focused = activeElement(t.root)
    expect(focused).toBe(t.row(2))
    // A new item goes first: every loaded row moves down one.
    const shifted = new Map<number, Row>([[0, { id: 'new', title: 'New' }]])
    for (const [i, row] of t.state.store) shifted.set(i + 1, row)
    t.state.store = shifted
    await nextTick()
    expect(t.row(3)).toBe(focused)
    expect(t.text(t.row(3))).toContain('Row 2')
  })

  it('lets a click cancel a keyboard move still waiting for its row', async () => {
    const t = setup(1000, 50)
    await nextTick()
    key(t.row(0), 'End')
    await nextTick()
    fire(t.row(3), 'click', { target: t.row(3) })
    t.state.store.set(999, { id: 'r999', title: 'Last' })
    await nextTick()
    expect(t.selected.map((r) => r.id)).toEqual(['r3'])
    expect(t.state.selectedId).toBe('r3')
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

describe('DataTable virtual mode, scrolling', () => {
  afterEach(() => {
    setLayout(null)
  })

  // A scroll box the virtualizer can observe: a window for its timers, a 400px height, and
  // the scroll height a browser would give 50,000 rows under the 36px header.
  function scrollable() {
    const win = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => {
        clearTimeout(id)
      },
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => {
        clearTimeout(id)
      },
    }
    setLayout((el) => {
      if (el.tag === 'div')
        Object.assign(el, {
          ownerDocument: { defaultView: win },
          clientWidth: 800,
          clientHeight: 400,
          scrollHeight: 36 + 50_000 * 38,
          scrollLeft: 0,
        })
    })
    const t = setup(50_000)
    const scrollTo = async (top: number) => {
      const el = box(t.root)
      el.scrollTop = top
      fire(el, 'scroll')
      await nextTick()
    }
    return { ...t, scrollTo }
  }

  it('asks for the new window when scrolling reaches it', async () => {
    const t = scrollable()
    await nextTick()
    expect(t.windows.map((w) => w.offsets)).toEqual([[0]])
    // Scrolled 300 rows down, row 299 is at the top under the header: rows 297 to 311 render
    // (2 above for a quick scroll), all in the window at 200.
    await t.scrollTo(300 * 38)
    expect(t.windows.map((w) => w.offsets)).toEqual([[0], [200]])
    expect(t.rows()[0]?.props['data-index']).toBe(297)
    // Across a window edge, both windows are asked for.
    await t.scrollTo(395 * 38)
    expect(t.windows.at(-1)).toMatchObject({ offsets: [200, 400] })
  })

  it('keeps the focused row rendered when the wheel scrolls it out of view', async () => {
    const t = scrollable()
    await nextTick()
    key(t.row(0), 'ArrowDown')
    await nextTick()
    const focused = t.row(1)
    expect(activeElement(t.root)).toBe(focused)
    await t.scrollTo(300 * 38)
    // Row 1 stays where it belongs, between a spacer for row 0 and one up to row 297, and
    // keeps focus, so the next arrow key moves on from it.
    expect(t.rows().map((r) => r.props['data-index'])).toEqual([
      1,
      ...Array.from({ length: 15 }, (_, i) => 297 + i),
    ])
    expect(t.row(1)).toBe(focused)
    expect(activeElement(t.root)).toBe(focused)
    const spacers = findAll(t.root, (n) => n.tag === 'tr' && 'data-spacer' in n.props)
    expect(spacers.map((n) => n.props['data-spacer'])).toEqual(['above', 'between', 'below'])
    // The kept row is not in view: only the window in view is asked for.
    expect(t.windows.at(-1)?.offsets).toEqual([200])
    expect(t.table.value?.isInView(1)).toBe(false)
    expect(t.table.value?.isInView(300)).toBe(true)
  })

  it('keeps focus on its item when a row is added above it while scrolled away', async () => {
    const t = scrollable()
    await nextTick()
    key(t.row(0), 'ArrowDown')
    await nextTick()
    const focused = t.row(1)
    await t.scrollTo(300 * 38)
    // A live create: every loaded row moves down one.
    const shifted = new Map<number, Row>([[0, { id: 'new', title: 'New' }]])
    for (const [i, row] of t.state.store) shifted.set(i + 1, row)
    t.state.store = shifted
    await nextTick()
    await nextTick()
    // Row 1's item is now at row 2: its element is kept there, still focused.
    expect(t.row(2)).toBe(focused)
    expect(t.text(t.row(2))).toContain('Row 1')
    expect(activeElement(t.root)).toBe(focused)
    expect(t.rows().map((r) => r.props['data-index'])).not.toContain(1)
  })

  it('keeps a row reached with Tab rendered too', async () => {
    const t = scrollable()
    await nextTick()
    fire(t.row(4), 'focusin')
    await t.scrollTo(300 * 38)
    expect(t.rows()[0]?.props['data-index']).toBe(4)
  })

  it('asks for nothing while scrolling inside the windows it already asked for', async () => {
    const t = scrollable()
    await nextTick()
    await t.scrollTo(300 * 38)
    const asked = t.windows.length
    await t.scrollTo(320 * 38)
    await t.scrollTo(250 * 38)
    expect(t.rows()[0]?.props['data-index']).toBe(247)
    expect(t.windows).toHaveLength(asked)
  })
})
