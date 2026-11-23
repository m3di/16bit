/**
 * No main-thread task over 50 ms while burndown charts render on a production build (issue 259).
 * Not part of CI: run `pnpm --filter @16bit/e2e perf:burndown [cpuThrottle]` (default 4) after a
 * change to BurndownChart. It builds apps/web/perf/burndown, serves it with `vite preview`, mounts
 * four charts (one a 366-day year), then runs 20 data updates, 4 theme switches and 4 resizes in
 * Chromium under a `longtask` observer. Exits 1 if any task is over 50 ms. With PERF_URL set it
 * measures an already served build instead of building and serving one.
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const web = fileURLToPath(new URL('../../apps/web', import.meta.url))
const config = 'perf/burndown/vite.config.ts'
const port = 4259
const throttle = Number(process.argv[2] ?? '4')
const BUDGET_MS = 50

const given = process.env['PERF_URL']
if (!given) {
  const built = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', config], {
    cwd: web,
    stdio: 'inherit',
  })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
const preview = given
  ? null
  : spawn(
      'pnpm',
      ['exec', 'vite', 'preview', '--config', config, '--port', String(port), '--strictPort'],
      { cwd: web, stdio: 'ignore' },
    )

async function waitForServer(url: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${url} did not start`)
}

type Step = [fn: string, arg?: number]
const steps: Step[] = [
  ['mountCharts'],
  ...Array.from({ length: 20 }, (): Step => ['updateCharts']),
  ...Array.from({ length: 4 }, (): Step => ['toggleTheme']),
  ...[600, 380, 1100, 960].map((px): Step => ['resizeCharts', px]),
]

try {
  const url = given ?? `http://127.0.0.1:${String(port)}/`
  await waitForServer(url)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    const store: number[] = []
    Object.assign(window, { longTasks: store })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.push(Math.round(entry.duration))
    }).observe({ type: 'longtask' })
  })
  const byStep: string[] = []
  for (const [fn, arg] of steps) {
    const before = await page.evaluate(
      () => (window as unknown as { longTasks: number[] }).longTasks.length,
    )
    await page.evaluate(
      async ([name, value]) => {
        const target = (window as unknown as Record<string, (v?: number) => void>)[name]
        target?.(value)
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      },
      [fn, arg] as const,
    )
    const after = await page.evaluate(
      (from) => (window as unknown as { longTasks: number[] }).longTasks.slice(from),
      before,
    )
    if (after.length)
      byStep.push(`${fn}${arg === undefined ? '' : `(${String(arg)})`}: ${after.join(', ')} ms`)
  }
  await page.waitForTimeout(500)
  const long = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)
  await browser.close()
  const over = long.filter((ms) => ms > BUDGET_MS)
  console.log(
    `CPU throttle ${String(throttle)}x: ${String(long.length)} long tasks` +
      (long.length ? ` (${long.join(', ')} ms)` : '') +
      `, ${String(over.length)} over ${String(BUDGET_MS)} ms`,
  )
  for (const line of byStep) console.log(`  ${line}`)
  process.exitCode = over.length ? 1 : 0
} finally {
  preview?.kill()
}
