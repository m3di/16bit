import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BurndownChart from './BurndownChart.vue'
import {
  MAX_DAYS,
  burndown,
  burndownGeometry,
  formatDay,
  sprintDays,
  todayText,
  type BurndownInput,
} from './burndown.ts'

// The mockup's sprint: Nov 9 to Nov 20 2026 is 10 weekdays; today Nov 16 is day 6 (D81).
const mockup: BurndownInput = {
  start: '2026-11-09',
  end: '2026-11-20',
  total: 34,
  doneByDay: {
    '2026-11-09': 3,
    '2026-11-10': 2,
    '2026-11-11': 3,
    '2026-11-12': 5,
    '2026-11-14': 1,
    '2026-11-16': 2,
  },
  today: '2026-11-16',
}

describe('sprintDays', () => {
  it('counts weekdays by default, as the mockup', () => {
    const days = sprintDays('2026-11-09', '2026-11-20')
    expect(days).toHaveLength(10)
    expect(days.indexOf('2026-11-16') + 1).toBe(6)
    expect(days).not.toContain('2026-11-14')
  })

  it('counts calendar days when asked', () => {
    expect(sprintDays('2026-11-09', '2026-11-20', 'calendar')).toHaveLength(12)
  })

  it('is empty for bad or reversed dates and capped at a year', () => {
    expect(sprintDays('2026-11-20', '2026-11-09')).toEqual([])
    expect(sprintDays('nope', '2026-11-09')).toEqual([])
    expect(sprintDays('2020-01-01', '2029-12-31', 'calendar')).toHaveLength(MAX_DAYS)
  })

  it('does not move a day across a daylight saving change in the local zone', () => {
    const saved = process.env['TZ']
    try {
      // Node reads TZ again when it changes. US clocks go forward on Sunday Mar 8 2026, Europe's
      // on Sunday Mar 29: neither may drop, repeat or shift a day.
      for (const zone of ['America/New_York', 'Europe/Berlin', 'Australia/Sydney']) {
        process.env['TZ'] = zone
        expect(new Date(2026, 2, 7, 12).getTimezoneOffset()).not.toBe(
          new Date(2026, 6, 8, 12).getTimezoneOffset(),
        )
        expect(sprintDays('2026-03-06', '2026-03-10', 'calendar')).toEqual([
          '2026-03-06',
          '2026-03-07',
          '2026-03-08',
          '2026-03-09',
          '2026-03-10',
        ])
        expect(sprintDays('2026-03-27', '2026-03-31')).toEqual([
          '2026-03-27',
          '2026-03-30',
          '2026-03-31',
        ])
      }
    } finally {
      if (saved === undefined) delete process.env['TZ']
      else process.env['TZ'] = saved
    }
  })
})

describe('burndown', () => {
  it('reproduces the mockup: 34, 31, 29, 26, 21 and 18 today', () => {
    const b = burndown(mockup)
    expect(b.actual).toEqual([34, 31, 29, 26, 21, 18])
    expect(b.todayIndex).toBe(5)
    expect(b.ideal).toHaveLength(11)
    expect(b.ideal[0]).toBe(34)
    expect(b.ideal[10]).toBe(0)
  })

  it('counts weekend work on the next weekday and draws a weekend today at Friday', () => {
    const b = burndown({ ...mockup, today: '2026-11-15' })
    expect(b.todayIndex).toBe(4)
    expect(b.actual).toEqual([34, 31, 29, 26, 20])
  })

  it('shows only the ideal line before the sprint starts', () => {
    const b = burndown({ ...mockup, today: '2026-11-01' })
    expect(b.actual).toEqual([])
    expect(b.todayIndex).toBeNull()
  })

  it('after the sprint, ends with the points left at its end and no today', () => {
    const b = burndown({ ...mockup, today: '2026-12-01', doneByDay: { '2026-11-25': 34 } })
    expect(b.actual).toHaveLength(11)
    expect(b.actual.at(-1)).toBe(34)
    expect(b.todayIndex).toBeNull()
  })

  it('counts work done before the start from the first day, and never goes below 0', () => {
    const b = burndown({ ...mockup, doneByDay: { '2026-11-01': 4, '2026-11-10': 99 } })
    expect(b.actual[0]).toBe(30)
    expect(b.actual.at(-1)).toBe(0)
  })

  it('marks a weekend today as not a sprint day', () => {
    expect(burndown(mockup).todayIsDay).toBe(true)
    expect(burndown({ ...mockup, today: '2026-11-14' }).todayIsDay).toBe(false)
  })

  it('draws a today on a Saturday start at the first weekday, holding the points left now', () => {
    const b = burndown({
      ...mockup,
      start: '2026-11-07',
      today: '2026-11-07',
      doneByDay: { '2026-11-07': 4 },
    })
    expect(b.days[0]).toBe('2026-11-09')
    expect(b.todayIndex).toBe(0)
    expect(b.todayIsDay).toBe(false)
    expect(b.actual).toEqual([30])
  })

  it('past the 366-day cap, ends the sprint at the last drawn day', () => {
    const long = {
      start: '2026-01-01',
      end: '2027-06-30',
      total: 100,
      days: 'calendar' as const,
      doneByDay: { '2026-06-01': 10, '2027-01-05': 30 },
    }
    const during = burndown({ ...long, today: '2027-03-01' })
    expect(during.days).toHaveLength(MAX_DAYS)
    expect(during.days.at(-1)).toBe('2027-01-01')
    // Today is past the drawn axis, so it is after the (capped) sprint: no today, an end point.
    expect(during.todayIndex).toBeNull()
    expect(during.actual).toHaveLength(MAX_DAYS + 1)
    expect(during.actual.at(-1)).toBe(90)
    const inside = burndown({ ...long, today: '2026-12-31' })
    expect(inside.todayIndex).toBe(MAX_DAYS - 2)
    expect(inside.actual).toHaveLength(MAX_DAYS - 1)
  })

  it('with no points, draws the line on 0 and labels only 0', () => {
    const b = burndown({ ...mockup, total: 0, doneByDay: {} })
    expect(b.actual).toEqual([0, 0, 0, 0, 0, 0])
    const g = burndownGeometry(b)
    expect(g.yLabels.map((l) => l.text)).toEqual(['0'])
    expect(g.grid).toEqual([170])
    expect(g.actualPath).toMatch(/^M40 170L83 170/)
    expect(g.today?.text).toBe('Today: 0 points left')
  })

  it('ignores bad dates and non-positive points', () => {
    const b = burndown({ ...mockup, doneByDay: { yesterday: 5, '2026-11-09': -3 } })
    expect(b.actual).toEqual([34, 34, 34, 34, 34, 34])
  })

  it('has nothing to draw without sprint days', () => {
    const b = burndown({ ...mockup, start: '2026-11-14', end: '2026-11-15' })
    expect(b.days).toEqual([])
    expect(burndownGeometry(b).idealPath).toBe('')
  })
})

describe('burndownGeometry', () => {
  it('places the mockup at the mockup coordinates', () => {
    const g = burndownGeometry(burndown(mockup))
    expect(g.idealPath).toBe(
      'M40 20L83 35L126 50L169 65L212 80L255 95L298 110L341 125L384 140L427 155L470 170',
    )
    expect(g.actualPath).toBe('M40 20L83 33.2L126 42.1L169 55.3L212 77.4L255 90.6')
    expect(g.dots).toHaveLength(5)
    expect(g.today).toMatchObject({ x: 255, y: 90.6, text: 'Today: 18 points left' })
    expect(g.yLabels.map((l) => l.text)).toEqual(['34', '17', '0'])
    expect(g.xLabels.map((l) => l.text)).toEqual(['Nov 9', 'Nov 16', 'Nov 20'])
  })

  it('keeps the today label inside the chart near the right edge', () => {
    const g = burndownGeometry(burndown({ ...mockup, today: '2026-11-20' }), 320)
    expect(g.today).not.toBeNull()
    const box = g.today?.box
    expect((box?.x ?? 0) + (box?.w ?? 0)).toBeLessThanOrEqual(320)
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  })

  it('drops overlapping day labels and dots on long sprints', () => {
    const b = burndown({ ...mockup, start: '2026-01-01', end: '2026-06-30', days: 'calendar' })
    const g = burndownGeometry(b, 300)
    expect(g.dots).toEqual([])
    for (let i = 1; i < g.xLabels.length; i++) {
      expect((g.xLabels[i]?.x ?? 0) - (g.xLabels[i - 1]?.x ?? 0)).toBeGreaterThanOrEqual(56)
    }
  })

  it('formats days and the today text', () => {
    expect(formatDay('2026-11-09')).toBe('Nov 9')
    expect(todayText(1)).toBe('Today: 1 point left')
    expect(todayText(2.25)).toBe('Today: 2.3 points left')
  })
})

describe('BurndownChart', () => {
  const render = (props: BurndownInput) =>
    renderToString(createSSRApp({ render: () => h(BurndownChart, { ...props }) }))

  it('hides the SVG from screen readers and gives them a table', async () => {
    const html = await render({ ...mockup })
    expect(html).toMatch(/<svg aria-hidden="true"/)
    expect(html).toContain('<table class="sr-only">')
    expect(html).toContain('Points left by day')
    expect(html).toMatch(/<th scope="row">Nov 16, today<\/th><td>18<\/td>/)
    expect(html).toMatch(/<th scope="row">Nov 20<\/th><td>Not yet<\/td>/)
  })

  it('colours come from token utilities, not values', async () => {
    const html = await render({ ...mockup })
    expect(html).toContain('stroke-accent')
    expect(html).toContain('stroke-ink3')
    expect(html).toContain('stroke-line')
    expect(html).toContain('fill-ink')
    expect(html).not.toMatch(/(fill|stroke)="#/)
  })

  it('on a weekend, the row at Friday holds the points left now and is not called today', async () => {
    const html = await render({ ...mockup, today: '2026-11-14' })
    expect(html).toContain('Nov 13, points left now (today is Nov 14)')
    expect(html).not.toContain('Nov 13, today')
  })

  it('adds an end row after the sprint', async () => {
    const html = await render({ ...mockup, today: '2026-12-01' })
    expect(html).toContain('End of sprint')
    expect(html).not.toContain('Today:')
  })
})
