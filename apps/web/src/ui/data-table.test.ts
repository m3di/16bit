import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import DataTable, { type TableColumn } from './DataTable.vue'

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
