import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { rowKeyIndex, windowOffsets } from './data-table.ts'
import DataTable, { type TableColumn, type TableMode } from './DataTable.vue'

const rows = [{ id: 'r1' }]

const render = (columns: TableColumn[]) =>
  renderToString(
    createSSRApp({
      render: () => h(DataTable, { caption: 'Items', columns, rows }, { cell: () => 'x' }),
    }),
  )

const header = (html: string, label: string) =>
  [...html.matchAll(/<th[^>]*>[\s\S]*?<\/th>/g)]
    .map((m) => m[0])
    .find((th) => th.replace(/<[^>]*>/g, '').trim() === label) ?? ''

/** The chevrons a header's sort icon draws. */
const chevrons = (th: string) => [...th.matchAll(/data-chevron="(up|down)"/g)].map((m) => m[1])

describe('DataTable sortable headers', () => {
  it('keeps the icon one size in every state, so the label does not move', async () => {
    for (const sort of ['none', 'ascending', 'descending'] as const) {
      const th = header(await render([{ key: 's', label: 'Stage', sort }]), 'Stage')
      expect(th).toMatch(/<svg[^>]*width="10" height="14"/)
    }
  })

  it('shows a cue at rest: both chevrons, no aria-sort, label in the header ink', async () => {
    const th = header(await render([{ key: 'stage', label: 'Stage', sort: 'none' }]), 'Stage')
    expect(th).toMatch(/<button type="button"/)
    expect(th).toContain('data-sort-icon="none"')
    expect(th).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(chevrons(th)).toEqual(['up', 'down'])
    expect(th).not.toContain('aria-sort')
    expect(th).not.toContain('font-medium')
  })

  it('shows a single up chevron when ascending, and marks the header', async () => {
    const th = header(await render([{ key: 'stage', label: 'Stage', sort: 'ascending' }]), 'Stage')
    expect(th).toContain('aria-sort="ascending"')
    expect(th).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(chevrons(th)).toEqual(['up'])
    expect(th).toContain('font-medium text-ink')
  })

  it('shows a single down chevron when descending', async () => {
    const th = header(await render([{ key: 'stage', label: 'Stage', sort: 'descending' }]), 'Stage')
    expect(th).toContain('aria-sort="descending"')
    expect(th).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(chevrons(th)).toEqual(['down'])
  })

  it('puts the icon after the label, or before it in a right-aligned column', async () => {
    const html = await render([
      { key: 'stage', label: 'Stage', sort: 'none' },
      { key: 'points', label: 'Points', sort: 'ascending', align: 'end' },
    ])
    const stage = header(html, 'Stage')
    const points = header(html, 'Points')
    expect(stage.indexOf('Stage')).toBeLessThan(stage.indexOf('<svg'))
    expect(points.indexOf('<svg')).toBeLessThan(points.indexOf('Points'))
    expect(points.match(/<svg/g)).toHaveLength(1)
    expect(stage.match(/<svg/g)).toHaveLength(1)
  })

  it('gives a column that cannot be sorted no button, no icon, and no caption note', async () => {
    const html = await render([{ key: 'title', label: 'Title' }])
    const th = header(html, 'Title')
    expect(th).not.toContain('<button')
    expect(th).not.toContain('<svg')
    expect(html).not.toContain('sortable')
  })

  it('tells screen readers in the caption that header buttons sort', async () => {
    const html = await render([
      { key: 'title', label: 'Title' },
      { key: 'stage', label: 'Stage', sort: 'none' },
    ])
    expect(html).toContain('column headers with buttons are sortable')
  })
})

describe('DataTable static mode', () => {
  const people = [
    { id: 'p1', name: 'Priya' },
    { id: 'p2', name: 'Tomas' },
  ]
  const columns: TableColumn[] = [
    { key: 'name', label: 'Name', rowHeader: true, wrap: true },
    { key: 'hubs', label: 'Hubs' },
    { key: 'actions', label: 'Actions', labelHidden: true, align: 'end', shrink: true },
  ]
  const renderStatic = (
    props: Partial<{
      mode: TableMode
      selectedId: string
      minWidth: number
      rowAttrs: (row: { id: string }) => Record<string, string | boolean>
    }> = {},
  ) =>
    renderToString(
      createSSRApp({
        render: () =>
          h(
            DataTable,
            { caption: 'People', columns, rows: people, mode: 'static', ...props },
            { cell: ({ row }: { row: { id: string } }) => row.id },
          ),
      }),
    )
  const bodyRows = (html: string) => [...html.matchAll(/<tr[^>]*data-row[^>]*>/g)].map((m) => m[0])
  const cells = (html: string) =>
    [...(html.split('<tbody>')[1] ?? '').matchAll(/<(th|td)[^>]*>/g)].map((m) => m[0])

  it('never marks a row selected, and rows offer no pointer or hover fill', async () => {
    const html = await renderStatic({ selectedId: 'p1' })
    expect(html).toContain('data-mode="static"')
    for (const tr of bodyRows(html)) {
      expect(tr).not.toContain('aria-selected')
      expect(tr).not.toContain('cursor-pointer')
      expect(tr).not.toContain('hover:bg-surface')
      expect(tr).not.toContain('bg-selected')
    }
  })

  it('still marks the selected row in select mode', async () => {
    const html = await renderStatic({ mode: 'select', selectedId: 'p1' })
    const [first, second] = bodyRows(html)
    expect(first).toContain('aria-selected="true"')
    expect(first).toContain('cursor-pointer')
    expect(second).not.toContain('aria-selected')
  })

  it('names each row with a row header', async () => {
    const [name, hubs] = cells(await renderStatic())
    expect(name).toMatch(/^<th[^>]*scope="row"/)
    expect(hubs).toMatch(/^<td/)
    expect(hubs).not.toContain('scope')
  })

  it('cuts plain cells, never wrap or shrink cells, and keeps a shrink column narrow', async () => {
    const [name, hubs, actions] = cells(await renderStatic())
    expect(hubs).toContain('truncate')
    expect(name).not.toContain('truncate')
    expect(actions).not.toContain('truncate')
    expect(actions).toContain('w-px whitespace-nowrap')
    expect(actions).toContain('text-right')
  })

  it('lays rows out as the settings mockups do: flush, 12px apart, 38px high', async () => {
    const html = await renderStatic()
    const [name] = cells(html)
    expect(name).toContain('h-[38px] pr-3 last:pr-0')
    expect(name).not.toContain('px-2')
    const th = header(html, 'Name')
    expect(th).toContain('h-8 pr-3 text-caption')
  })

  it('reads a hidden header to screen readers only', async () => {
    const html = await renderStatic()
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*><span class="sr-only">Actions<\/span><\/th>/)
  })

  it('puts row attributes on each row and sets where the table starts to scroll', async () => {
    const html = await renderStatic({
      minWidth: 480,
      rowAttrs: (row: { id: string }) => ({ 'data-member-row': true, 'data-member-id': row.id }),
    })
    expect(html).toMatch(/<table[^>]*style="min-width:480px;"/)
    const [first, second] = bodyRows(html)
    expect(first).toContain('data-member-row')
    expect(first).toContain('data-member-id="p1"')
    expect(second).toContain('data-member-id="p2"')
  })
})

describe('DataTable virtual mode', () => {
  type Row = { id: string; title: string }
  const columns: TableColumn[] = [
    { key: 'ref', label: 'ID', width: '96px', rowHeader: true },
    { key: 'title', label: 'Title', wrap: true },
    { key: 'points', label: 'Points', align: 'end', sort: 'none' },
  ]
  const renderVirtual = (
    props: Partial<{ rowCount: number; loaded: number; selectedId: string; busy: boolean }> = {},
  ) => {
    const { rowCount = 50_000, loaded = 4, ...rest } = props
    // Rows past `loaded` are not loaded yet.
    const rowAt = (i: number): Row | undefined =>
      i < loaded ? { id: `r${String(i)}`, title: `Row ${String(i)}` } : undefined
    return renderToString(
      createSSRApp({
        render: () =>
          h(
            DataTable,
            {
              caption: 'Items',
              columns,
              rows: [],
              rowAt,
              rowCount,
              mode: 'virtual',
              height: 400,
              ...rest,
            },
            { cell: ({ row }: { row: { id: string } }) => (row as Row).title },
          ),
      }),
    )
  }
  const bodyRows = (html: string) =>
    [...html.matchAll(/<tr[^>]*data-index[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0])
  const spacer = (html: string, where: string) =>
    Number(
      new RegExp(`data-spacer="${where}"><td[^>]*style="height:(\\d+)px;`).exec(html)?.[1] ?? -1,
    )

  it('tells screen readers how many rows there are and where each one is', async () => {
    const html = await renderVirtual()
    expect(html).toMatch(/<table[^>]*aria-rowcount="50001"/)
    expect(html).toMatch(/<thead><tr[^>]*aria-rowindex="1"/)
    const rows = bodyRows(html)
    expect(rows[0]).toContain('aria-rowindex="2"')
    expect(rows[3]).toContain('aria-rowindex="5"')
    expect(html).toContain('arrow keys on a row move the selection')
  })

  it('renders the rows in view only, with space below for the rest of the scrollbar', async () => {
    const html = await renderVirtual()
    const rows = bodyRows(html)
    expect(rows).toHaveLength(18)
    expect(spacer(html, 'above')).toBe(-1)
    expect(spacer(html, 'below')).toBe((50_000 - 18) * 38)
  })

  it('shows rows not loaded yet as placeholders, which are not selectable', async () => {
    const rows = bodyRows(await renderVirtual({ loaded: 2 }))
    expect(rows[1]).toContain('data-row')
    expect(rows[1]).toContain('Row 1')
    const placeholder = rows[2] ?? ''
    expect(placeholder).toContain('data-placeholder')
    expect(placeholder).not.toContain('data-row')
    expect(placeholder).toContain('aria-busy="true"')
    expect(placeholder).toContain('<span class="sr-only">Loading</span>')
    expect(placeholder).toMatch(/aria-hidden="true" class="[^"]*bg-empty/)
    expect(placeholder).not.toContain('cursor-pointer')
    expect(placeholder).not.toContain('role="status"')
    expect(placeholder).not.toContain('aria-live')
  })

  it('marks the selected row and gives it the tab stop', async () => {
    const rows = bodyRows(await renderVirtual({ selectedId: 'r2' }))
    expect(rows[2]).toContain('aria-selected="true"')
    expect(rows[2]).toContain('bg-selected')
    expect(rows[2]).toContain('tabindex="0"')
    expect(rows.filter((r) => r.includes('tabindex="0"'))).toHaveLength(1)
    expect(rows[0]).toContain('tabindex="-1"')
  })

  it('keeps every row one line and 38px high, with a fixed column layout', async () => {
    const html = await renderVirtual()
    expect(html).toMatch(/<table class="[^"]*table-fixed border-separate/)
    expect(html).toMatch(/<th[^>]*style="width:96px;"/)
    for (const row of bodyRows(html)) {
      for (const cell of row.match(/<(th|td)[^>]*>/g) ?? []) {
        expect(cell).toContain('h-[38px] truncate border-b border-line')
      }
    }
  })

  it('keeps the header in view and sortable', async () => {
    const html = await renderVirtual({ busy: true })
    expect(html).toMatch(/<div class="relative min-w-0 overflow-auto[^"]*"[^>]*height:400px/)
    expect(header(html, 'Points')).toContain('sticky top-0')
    expect(header(html, 'Points')).toContain('<button type="button"')
    expect(html).toMatch(/<table[^>]*aria-busy="true"/)
  })
})

describe('windowOffsets', () => {
  it('lists the windows that hold a range of rows', () => {
    expect(windowOffsets(0, 18, 200)).toEqual([0])
    expect(windowOffsets(190, 215, 200)).toEqual([0, 200])
    expect(windowOffsets(200, 400, 200)).toEqual([200])
    expect(windowOffsets(24_990, 25_010, 200)).toEqual([24_800, 25_000])
  })

  it('lists nothing for an empty range', () => {
    expect(windowOffsets(5, 5, 200)).toEqual([])
    expect(windowOffsets(0, 10, 0)).toEqual([])
  })
})

describe('rowKeyIndex', () => {
  it('moves one row and stops at the ends', () => {
    expect(rowKeyIndex(4, 'ArrowDown', 10, 5)).toBe(5)
    expect(rowKeyIndex(4, 'ArrowUp', 10, 5)).toBe(3)
    expect(rowKeyIndex(9, 'ArrowDown', 10, 5)).toBe(9)
    expect(rowKeyIndex(0, 'ArrowUp', 10, 5)).toBe(0)
  })

  it('pages and jumps', () => {
    expect(rowKeyIndex(4, 'PageDown', 100, 9)).toBe(13)
    expect(rowKeyIndex(4, 'PageUp', 100, 9)).toBe(0)
    expect(rowKeyIndex(95, 'PageDown', 100, 9)).toBe(99)
    expect(rowKeyIndex(50, 'Home', 100, 9)).toBe(0)
    expect(rowKeyIndex(50, 'End', 100, 9)).toBe(99)
  })

  it('starts at an end when nothing is selected, and ignores other keys', () => {
    expect(rowKeyIndex(-1, 'ArrowDown', 10, 5)).toBe(0)
    expect(rowKeyIndex(-1, 'ArrowUp', 10, 5)).toBe(9)
    expect(rowKeyIndex(3, 'Enter', 10, 5)).toBeNull()
    expect(rowKeyIndex(0, 'ArrowDown', 0, 5)).toBeNull()
  })
})
