import { expect, test, type Page } from '@playwright/test'

// The M3 exit's large-folder half (docs/ROADMAP.md, issue 178): D61's numbers for a 50,000-item
// folder in the default order. After a jump anywhere, rows show within one second (the median
// of several jumps); scrolling has no main-thread task over 50 ms, measured with a `longtask`
// observer; fewer than 100 rows are in the DOM. Needs `pnpm seed:large` (the `large`
// workspace, folder `large-items`, items LRG-1 to LRG-50000). Nothing here writes.
//
// The times are measured in the page, from the scroll to the frame that shows the rows, so the
// test runner's own round trips are not counted. Each run's numbers are recorded on the test.

const FOLDER = '/w/large/hubs/large/large-items'
const TOTAL = 50_000
const ROW = 38

/** Rows within one second of a jump, as the median of these jumps. Each lands in a window not read yet. */
const JUMPS = [3_000, 47_000, 12_345, 25_000, 38_700, 8_800, 49_500]
const JUMP_MEDIAN_MS = 1_000
const LONG_TASK_MS = 50
const MAX_ROWS_IN_DOM = 100

// The measured numbers, in the CI log as well as on the report.
// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
test.afterEach(({}, testInfo) => {
  const lines = testInfo.annotations
    .filter((a) => a.description)
    .map((a) => `  ${a.type}: ${a.description ?? ''}`)
  console.log([`[measured] ${testInfo.title}`, ...lines].join('\n'))
})

function table(page: Page) {
  return page.getByRole('table', { name: 'Items in All items' })
}

/** Rows rendered in the table body, loaded or not. */
function renderedRows(page: Page): Promise<number> {
  return table(page).locator('tbody tr[data-index]').count()
}

async function open(page: Page) {
  await page.goto(FOLDER)
  await expect(page.locator('[data-count]')).toHaveText('50,000 items')
  await expect(table(page).getByRole('link', { name: 'LRG-50000', exact: true })).toBeVisible()
}

/**
 * Scrolls the table's box to put row `index` at the top and resolves, in the page, with the
 * milliseconds until every row in view shows its item, row `index` among them.
 */
function jump(page: Page, index: number): Promise<number> {
  return page.evaluate(
    ({ index, row }) => {
      const box = document.querySelector<HTMLElement>('[data-virtual]')
      if (!box) throw new Error('No table box')
      const start = performance.now()
      box.scrollTop = index * row
      return new Promise<number>((resolve, reject) => {
        const check = () => {
          const view = box.getBoundingClientRect()
          const head = box.querySelector('thead')?.getBoundingClientRect().bottom ?? view.top
          const inView = [...box.querySelectorAll<HTMLElement>('tbody tr[data-index]')].filter(
            (tr) => {
              const r = tr.getBoundingClientRect()
              return r.bottom > head && r.top < view.bottom
            },
          )
          const shown = (tr: HTMLElement) =>
            !tr.hasAttribute('data-placeholder') &&
            /^LRG-\d+$/.test(tr.querySelector('a')?.textContent.trim() ?? '')
          const target = inView.find((tr) => tr.dataset['index'] === String(index))
          if (target && inView.every(shown)) resolve(performance.now() - start)
          else if (performance.now() - start > 10_000)
            reject(new Error(`Row ${String(index)} never showed`))
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
    },
    { index, row: ROW },
  )
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity
}

test('after a jump anywhere in 50,000 items, rows show within a second, with under 100 in the DOM', async ({
  page,
}) => {
  await open(page)
  const times: number[] = []
  for (const index of JUMPS) {
    times.push(await jump(page, index))
    // The right rows: newest first, so row `index` is item number 50,000 - index.
    await expect(
      table(page).getByRole('link', { name: `LRG-${String(TOTAL - index)}`, exact: true }),
    ).toBeInViewport()
    expect(await renderedRows(page)).toBeLessThan(MAX_ROWS_IN_DOM)
  }
  test.info().annotations.push({
    type: 'jumps',
    description: `median ${median(times).toFixed(0)} ms of ${times.map((t) => t.toFixed(0)).join(', ')}`,
  })
  expect(median(times)).toBeLessThan(JUMP_MEDIAN_MS)
})

/** The part of a `long-animation-frame` entry used here (not in TypeScript's DOM types yet). */
interface LongFrame {
  duration: number
  scripts: { invoker: string; sourceURL: string; duration: number }[]
}

/** What the page saw while scrolling, kept on `window` by the observers below. */
interface Seen {
  longTasks: number[]
  /** The scripts of each long animation frame, to say where the time went when a task is long. */
  scripts: string[]
}

test('scrolling 50,000 items has no main-thread task over 50 ms and keeps under 100 rows in the DOM', async ({
  page,
  browser,
}, testInfo) => {
  await open(page)
  // DIAG 307 (temporary): a Chromium trace of the scrolling on every other repeat.
  const tracing = !!process.env['DIAG_307']
  // DIAG 307 A/B: odd repeats stop the placeholder pulse animation.
  if (tracing && testInfo.repeatEachIndex % 2 === 1)
    await page.addStyleTag({ content: '[data-placeholder] .animate-pulse { animation: none !important; }' })
  if (tracing)
    await browser.startTracing(page, {
      path: testInfo.outputPath(`trace-307-${String(testInfo.repeatEachIndex)}.json`),
      categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute', 'blink.user_timing', 'loading', 'toplevel', 'disabled-by-default-v8.gc'],
    })
  // A browser that does not report long tasks would pass this test with none seen.
  expect(
    await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')),
  ).toBe(true)
  // Observed from here on, so loading the app is not counted, only the scrolling.
  await page.evaluate((longTask) => {
    const seen: Seen = { longTasks: [], scripts: [] }
    new PerformanceObserver((list) => {
      // Raw durations: rounding first would let a 50.4 ms task pass as 50.
      for (const entry of list.getEntries()) {
        seen.longTasks.push(entry.duration)
        ;(window as unknown as { diag: string[] }).diag.push(`task @${entry.startTime.toFixed(0)} ${entry.duration.toFixed(1)} ms`)
      }
    }).observe({ type: 'longtask' })
    ;(window as unknown as { diag: string[] }).diag = []
    new PerformanceObserver((list) => {
      for (const f of list.getEntries() as unknown as (LongFrame & { startTime: number; renderStart: number; styleAndLayoutStart: number; blockingDuration: number; scripts: { duration: number; forcedStyleAndLayoutDuration: number; startTime: number; invoker: string }[] })[]) {
        if (f.duration <= 40) continue
        const script = f.scripts.reduce((a, s) => a + s.duration, 0)
        const forced = f.scripts.reduce((a, s) => a + s.forcedStyleAndLayoutDuration, 0)
        const firstScript = f.scripts[0]?.startTime ?? f.renderStart
        ;(window as unknown as { diag: string[] }).diag.push(
          `frame @${f.startTime.toFixed(0)} ${f.duration.toFixed(0)} ms blocking ${f.blockingDuration.toFixed(0)} | before scripts ${(firstScript - f.startTime).toFixed(0)} | scripts ${script.toFixed(0)} (forced layout ${forced.toFixed(0)}) | renderStart +${(f.renderStart ? f.renderStart - f.startTime : -1).toFixed(0)} | style+layout +${(f.styleAndLayoutStart ? f.styleAndLayoutStart - f.startTime : -1).toFixed(0)} | after style ${(f.styleAndLayoutStart ? f.startTime + f.duration - f.styleAndLayoutStart : -1).toFixed(0)} | ${f.scripts.map((s) => s.invoker + ' ' + s.duration.toFixed(0)).join(', ')}`,
        )
      }
    }).observe({ type: 'long-animation-frame' })
    new PerformanceObserver((list) => {
      for (const frame of list.getEntries() as unknown as LongFrame[]) {
        if (frame.duration <= longTask) continue
        for (const script of frame.scripts) {
          const file = script.sourceURL.split('/').pop()?.split('?')[0] ?? ''
          seen.scripts.push(`${script.invoker} (${file}) ${String(Math.round(script.duration))} ms`)
        }
      }
    }).observe({ type: 'long-animation-frame' })
    ;(window as unknown as { seen: Seen }).seen = seen
  }, LONG_TASK_MS)
  const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
  const box = page.locator('[data-virtual]')
  let mostRows = 0

  // A person scrolling with the wheel: 60 notches of 1,500 px, about 2,400 rows, a dozen windows.
  await box.hover()
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 1_500)
    await nextFrame()
    mostRows = Math.max(mostRows, await renderedRows(page))
  }
  expect(await box.evaluate((el) => el.scrollTop)).toBeGreaterThan(2_000 * ROW)

  // Then dragging the scrollbar thumb down the whole folder, one position per frame.
  for (let i = 1; i <= 40; i++) {
    await box.evaluate(
      (el, top) => {
        el.scrollTop = top
      },
      Math.round((i / 40) * TOTAL * ROW),
    )
    await nextFrame()
    mostRows = Math.max(mostRows, await renderedRows(page))
  }
  // Until the rows at the end show, so the work of the last windows is counted too.
  await expect(table(page).getByRole('link', { name: 'LRG-1', exact: true })).toBeVisible()
  await nextFrame()

  // Entries reach the observer after their task ends: let one more task run first.
  const { longTasks, scripts } = await page.evaluate(
    () =>
      new Promise<Seen>((resolve) => {
        setTimeout(() => {
          resolve((window as unknown as { seen: Seen }).seen)
        })
      }),
  )
  if (tracing) await browser.stopTracing()
  if (process.env['DIAG_307']) {
    const diag = await page.evaluate(() => (window as unknown as { diag: string[] }).diag)
    const res = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/query')).map((r) => `query @${r.startTime.toFixed(0)}-${r.responseEnd.toFixed(0)} ${String((r as PerformanceResourceTiming).encodedBodySize)} B`))
    const counts = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-virtual] tbody tr[data-index]')
      const inRows = document.querySelectorAll('[data-virtual] tbody tr[data-index] *').length
      const rules = [...document.styleSheets].reduce((n, sh) => { try { return n + sh.cssRules.length } catch { return n } }, 0)
      const td = document.querySelector('[data-virtual] tbody td') as HTMLElement
      const tw = getComputedStyle(td).getPropertyValue('--tw-border-style')
      const fallback = `hyphens ${String(CSS.supports('(-webkit-hyphens:none)'))} margin-trim ${String(CSS.supports('(margin-trim:block)'))} --tw-border-style on a td "${tw}"; ${navigator.userAgent}; `
      return fallback + `elements: document ${String(document.querySelectorAll('*').length)}, ${String(rows.length)} rows with ${String(inRows)} inside; css rules ${String(rules)}`
    })
    res.push(counts)
    test.info().annotations.push({ type: 'diag307', description: [...diag, ...res].join('\n    ') })
  }
  test.info().annotations.push({
    type: 'scrolling',
    description: `long tasks: ${longTasks.length ? longTasks.map((ms) => ms.toFixed(0)).join(', ') + ' ms' : 'none'}; most rows in the DOM: ${String(mostRows)}`,
  })
  if (scripts.length) {
    test.info().annotations.push({ type: 'in long frames', description: scripts.join('; ') })
  }
  expect(mostRows).toBeLessThan(MAX_ROWS_IN_DOM)
  expect(longTasks.filter((ms) => ms > LONG_TASK_MS)).toEqual([])
})
