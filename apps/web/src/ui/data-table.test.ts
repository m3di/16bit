import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
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
