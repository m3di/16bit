/**
 * Burndown series and geometry for BurndownChart. D82: points left are the sprint's total points
 * minus the points done so far, by each item's "Done on" date; there is no history time series.
 * D81: the x-axis steps over weekdays (Monday to Friday, no holiday calendar) or calendar days.
 *
 * Dates are date-only ISO strings (`2026-11-09`), already in the reader's zone; they are read as
 * UTC here only so that no local offset can move them.
 */

export type DayMode = 'weekdays' | 'calendar'

/** At most a year of steps, as the aggregate's 366 date buckets (D80). */
export const MAX_DAYS = 366
/** Past this many steps the dots are dropped and only the line is drawn. */
export const MAX_DOTS = 31

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function toMs(date: string): number {
  if (!ISO_DATE.test(date)) return Number.NaN
  return Date.parse(`${date}T00:00:00Z`)
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The sprint's days from `start` to `end` inclusive, skipping Saturday and Sunday in weekdays. */
export function sprintDays(start: string, end: string, mode: DayMode = 'weekdays'): string[] {
  const from = toMs(start)
  const to = toMs(end)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return []
  const days: string[] = []
  for (let ms = from; ms <= to && days.length < MAX_DAYS; ms += DAY_MS) {
    const weekday = new Date(ms).getUTCDay()
    if (mode === 'calendar' || (weekday !== 0 && weekday !== 6)) days.push(toIso(ms))
  }
  return days
}

export interface BurndownInput {
  start: string
  end: string
  /** All points in the sprint, done or not. */
  total: number
  /** Points done per "Done on" date. Dates outside the sprint count where they fall. */
  doneByDay: Readonly<Record<string, number>>
  /** The reader's today. */
  today: string
  days?: DayMode
}

export interface Burndown {
  /** One step per sprint day. Tick `i` is the start of `days[i]`; tick `days.length` its end. */
  days: string[]
  total: number
  /** Ideal points left at each tick, `days.length + 1` values from the total down to 0. */
  ideal: number[]
  /** Points left at ticks 0, 1, ... up to today (or the end). Empty before the sprint starts. */
  actual: number[]
  /** The tick today is drawn at, or null outside the sprint. Its value is the points left now. */
  todayIndex: number | null
  /**
   * Whether today is itself a sprint day. False on a weekend in weekdays mode, or on a
   * Saturday or Sunday start before the first weekday: today is then drawn at a nearby day's tick.
   */
  todayIsDay: boolean
}

/**
 * Points left at the start of each sprint day up to today, and now at today's tick. On a weekend
 * in weekdays mode, today is drawn at the last weekday before it; a sprint that starts on a
 * Saturday or Sunday draws a today before its first weekday at that weekday's tick. After the
 * sprint, the last tick is the points left at its end. A sprint longer than MAX_DAYS ends at its
 * last drawn day, so today and the end point never fall past the axis.
 */
export function burndown(input: BurndownInput): Burndown {
  const days = sprintDays(input.start, input.end, input.days ?? 'weekdays')
  const total = Math.max(0, Number.isFinite(input.total) ? input.total : 0)
  const n = days.length
  const ideal = Array.from({ length: n + 1 }, (_, i) => (n === 0 ? 0 : total * (1 - i / n)))
  const empty: Burndown = { days, total, ideal, actual: [], todayIndex: null, todayIsDay: false }
  const lastDay = days[n - 1]
  if (lastDay === undefined) return empty
  // Past the cap the axis stops at the last drawn day, and so does the sprint.
  const end = n >= MAX_DAYS && lastDay < input.end ? lastDay : input.end

  // Points done on or before each date: one pass over the done dates in order.
  const done = Object.entries(input.doneByDay)
    .filter(([date, points]) => ISO_DATE.test(date) && Number.isFinite(points) && points > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const left = (before: string, inclusive: boolean): number => {
    let sum = 0
    for (const [date, points] of done) {
      if (date < before || (inclusive && date === before)) sum += points
      else break
    }
    return Math.max(0, total - sum)
  }

  const today = input.today
  if (!ISO_DATE.test(today) || today < input.start) return empty

  if (today > end) {
    const actual = days.map((day) => left(day, false))
    actual.push(left(end, true))
    return { ...empty, actual }
  }

  let t = 0
  for (let i = 0; i < n; i++) if ((days[i] ?? '') <= today) t = i
  const actual = days.slice(0, t).map((day) => left(day, false))
  actual.push(left(today, true))
  return { ...empty, actual, todayIndex: t, todayIsDay: days[t] === today }
}

/** Plot area inside the SVG, from the mockup's 480 by 200 viewBox. */
export const PLOT = { left: 40, rightPad: 10, top: 20, bottom: 170, height: 200 } as const

export interface ChartLabel {
  x: number
  y: number
  text: string
  anchor: 'start' | 'middle' | 'end'
}

export interface BurndownGeometry {
  width: number
  grid: number[]
  yLabels: ChartLabel[]
  xLabels: ChartLabel[]
  idealPath: string
  actualPath: string
  dots: { x: number; y: number }[]
  today: { x: number; y: number; text: string; box: { x: number; y: number; w: number } } | null
}

const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/** "Nov 9" from a date-only string. */
export function formatDay(date: string): string {
  const ms = toMs(date)
  return Number.isNaN(ms) ? date : dayLabel.format(ms)
}

/** Points as people write them: whole numbers, or one decimal. */
export function formatPoints(points: number): string {
  return String(Math.round(points * 10) / 10)
}

export function todayText(points: number): string {
  return `Today: ${formatPoints(points)} ${points === 1 ? 'point' : 'points'} left`
}

const round = (v: number) => Math.round(v * 10) / 10

/**
 * Coordinates for a chart `width` units wide (the box's width in px, so text stays 11px).
 * Estimating the label box at 6 units a character keeps it off the DOM: no layout read.
 */
export function burndownGeometry(b: Burndown, width = 480): BurndownGeometry {
  const right = Math.max(PLOT.left + 40, width - PLOT.rightPad)
  const n = b.days.length
  const top = Math.max(b.total, ...b.actual)
  // With no points at all the line lies on 0; the scale needs a span, the labels do not.
  const max = top > 0 ? top : 1
  const xAt = (i: number) => round(PLOT.left + ((right - PLOT.left) * i) / Math.max(1, n))
  const yAt = (v: number) => round(PLOT.bottom - ((PLOT.bottom - PLOT.top) * v) / max)
  const path = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${String(xAt(i))} ${String(yAt(v))}`).join('')

  const half = Math.round(max / 2)
  const levels = top > 0 ? [max, half, 0].filter((v, i, all) => all.indexOf(v) === i) : [0]
  const grid = levels.map(yAt)
  const yLabels = levels.map((v) => ({
    x: PLOT.left - 10,
    y: yAt(v) + 4,
    text: formatPoints(v),
    anchor: 'end' as const,
  }))

  const clampX = (x: number) => Math.min(Math.max(x, PLOT.left - 14), width - 24)
  const xLabels: ChartLabel[] = []
  const addX = (i: number) => {
    const day = b.days[i]
    if (day === undefined) return
    const x = clampX(xAt(i))
    if (xLabels.some((l) => Math.abs(l.x - x) < 56)) return
    xLabels.push({ x, y: PLOT.height - 8, text: formatDay(day), anchor: 'middle' })
  }
  if (n > 0) {
    addX(0)
    addX(n - 1)
    if (b.todayIndex !== null) addX(b.todayIndex)
  }

  const shown = b.actual.length
  const dots = n <= MAX_DOTS ? b.actual.slice(0, b.todayIndex === null ? shown : shown - 1) : []

  let today: BurndownGeometry['today'] = null
  const last = b.actual[shown - 1]
  if (b.todayIndex !== null && last !== undefined) {
    const x = xAt(b.todayIndex)
    const y = yAt(last)
    const text = todayText(last)
    const w = Math.round(text.length * 6 + 16)
    const boxX = x + 11 + w <= width - 2 ? x + 11 : x - 11 - w
    const boxY = y - 33 >= 2 ? y - 33 : y + 11
    today = { x, y, text, box: { x: round(boxX), y: round(boxY), w } }
  }

  return {
    width,
    grid,
    yLabels,
    xLabels: xLabels.sort((a, c) => a.x - c.x),
    idealPath: n > 0 ? path(b.ideal) : '',
    actualPath: shown > 1 ? path(b.actual) : '',
    dots: dots.map((v, i) => ({ x: xAt(i), y: yAt(v) })),
    today,
  }
}
