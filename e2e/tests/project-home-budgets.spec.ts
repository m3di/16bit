import { createdAgentKeySchema, type Item } from '@16bit/core'
import type { Browser, Page } from '@playwright/test'
import {
  currentSprint,
  inWorkspace,
  parcelPath,
  query,
  SCALE,
  type Api,
} from './support/project.ts'
import { expect, expectStatus, NO_STATE, test } from './support/roles.ts'
import { OWNER_STATE } from './support/auth-state.ts'

// The M4 exit's timing half (M4-12 point 6), on the production build like the other budgets
// (issue 228): project home is on screen within 1 s on the seeded Parcel Tracker, and within
// 2 s on `pnpm seed:large --project`'s 2,000-task hub while 15 agent keys write at D75's rate
// ("tens of writes per minute") with a second browser open on the same page; and no main-thread
// task runs over 50 ms while the burndown renders and re-renders.
//
// "On screen" is measured in the page, from the navigation's start to the first frame in which
// every data block of the view has its data. Each budget is the median of a few loads, as D61's
// are; every load is recorded on the test. The writes go to the scale hub only and put back
// what they change.

test.use({ timezoneId: 'UTC' })

const SEEDED_MS = 1_000
const SCALE_MS = 2_000
const LOADS = 5
const LONG_TASK_MS = 50
/** D75: 5 to 15 agents, tens of writes per minute. 15 keys, each writing every 10 s: 90 a minute. */
const AGENTS = 15
const WRITE_EVERY_MS = 10_000

// The measured numbers, in the CI log as well as on the report.
// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
test.afterEach(({}, testInfo) => {
  const lines = testInfo.annotations
    .filter((a) => a.description)
    .map((a) => `  ${a.type}: ${a.description ?? ''}`)
  console.log([`[measured] ${testInfo.title}`, ...lines].join('\n'))
})

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity
}

/**
 * Loads `path` `LOADS` times and returns, for each, the milliseconds from the navigation's start
 * to the first frame in which the view shows every data block with its data. The frames are
 * watched from an init script, so the time does not depend on when the test first looks.
 */
async function loads(page: Page, path: string): Promise<number[]> {
  await page.addInitScript(() => {
    const w = window as unknown as { __viewReady?: number }
    const check = () => {
      const blocks = [...document.querySelectorAll('[data-view-block]')]
      const ready =
        blocks.length > 0 &&
        blocks.every((b) => {
          const s = b.getAttribute('data-block-state')
          return s !== null && s !== 'loading'
        })
      if (ready) w.__viewReady = performance.now()
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
  const ready = () =>
    page.evaluate(() => (window as unknown as { __viewReady?: number }).__viewReady ?? null)
  const times: number[] = []
  for (let i = 0; i < LOADS; i++) {
    await page.goto(path)
    await expect.poll(ready, { timeout: 20_000 }).not.toBeNull()
    await expect(page.locator('[data-block-state="error"], [data-block-broken]')).toHaveCount(0)
    times.push((await ready()) ?? Infinity)
  }
  return times
}

async function ownerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: OWNER_STATE })
  return context.newPage()
}

test('project home is on screen within 1 s on the seeded hub', async ({ page }) => {
  const times = await loads(page, parcelPath())
  test.info().annotations.push({
    type: 'seeded home',
    description: `median ${median(times).toFixed(0)} ms of ${times.map((t) => t.toFixed(0)).join(', ')}`,
  })
  expect(median(times)).toBeLessThan(SEEDED_MS)
})

test('project home is on screen within 2 s on 2,000 tasks, with 15 agents writing and a second browser open', async ({
  as,
  browser,
  page,
  playwright,
  baseURL,
}) => {
  const owner = inWorkspace(as('owner'), SCALE.workspaceId)
  const sprint = await currentSprint(owner, 'UTC', SCALE)
  // One task of the current sprint per agent, so each write lands in the blocks on screen.
  const tasks = await query(owner, {
    from: SCALE.folders.backlog,
    where: { attribute: SCALE.attr.sprint, op: 'in', value: [sprint.id] },
    limit: AGENTS,
  })
  expect(tasks).toHaveLength(AGENTS)

  const keys: string[] = []
  const contexts: { dispose(): Promise<void> }[] = []
  const writes: Promise<void>[] = []
  const failed: string[] = []
  let written = 0
  const run = { stop: false }
  const stopped = () => run.stop
  try {
    const agents: Api[] = []
    for (let i = 0; i < AGENTS; i++) {
      const res = await owner.post(`/hubs/${SCALE.hubId}/agent-keys`, {
        name: `E2E budget ${String(i + 1)} ${crypto.randomUUID().slice(0, 8)}`,
        hubRole: 'editor',
      })
      await expectStatus(res, 201)
      const { key, secret } = createdAgentKeySchema.parse(await res.json())
      keys.push(key.id)
      const request = await playwright.request.newContext({
        baseURL,
        storageState: NO_STATE,
        extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
      })
      contexts.push(request)
      const path = (p: string) => `/v1/workspaces/${SCALE.workspaceId}${p}`
      agents.push({
        get: (p) => request.get(path(p)),
        post: (p, d) => request.post(path(p), { data: d }),
        put: (p, d) => request.put(path(p), { data: d }),
        patch: (p, d) => request.patch(path(p), { data: d }),
        delete: (p) => request.delete(path(p)),
      })
    }

    // Each agent renames its task every 10 s, staggered so the writes are spread out.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (const [i, agent] of agents.entries()) {
      let task = tasks[i] as Item
      const stored = task.values[SCALE.attr.title]
      const title = typeof stored === 'string' ? stored : ''
      writes.push(
        (async () => {
          await sleep((i * WRITE_EVERY_MS) / AGENTS)
          for (let n = 0; !stopped(); n++) {
            const res = await agent.patch(`/items/${task.id}`, {
              version: task.version,
              values: { [SCALE.attr.title]: `${title} (${String(n)})` },
            })
            if (res.status() === 200) {
              task = (await res.json()) as Item
              written++
            } else {
              failed.push(`${String(res.status())} ${await res.text()}`)
            }
            for (let w = 0; w < WRITE_EVERY_MS && !stopped(); w += 250) await sleep(250)
          }
          // Put the title back.
          await agent.patch(`/items/${task.id}`, {
            version: task.version,
            values: { [SCALE.attr.title]: title },
          })
        })(),
      )
    }

    // A second browser on the same page, following the same writes.
    const second = await ownerPage(browser)
    await second.goto(parcelPath(undefined, SCALE))
    await expect(second.locator('[data-root-view] [data-live]')).toContainText('Live')

    const times = await loads(page, parcelPath(undefined, SCALE))
    test.info().annotations.push({
      type: '2,000 tasks',
      description: `median ${median(times).toFixed(0)} ms of ${times.map((t) => t.toFixed(0)).join(', ')}; ${String(written)} agent writes meanwhile`,
    })
    expect(failed).toEqual([])
    expect(written).toBeGreaterThan(0)
    expect(median(times)).toBeLessThan(SCALE_MS)
    await second.context().close()
  } finally {
    run.stop = true
    await Promise.all(writes)
    for (const id of keys) await owner.post(`/agent-keys/${encodeURIComponent(id)}/revoke`)
    await Promise.all(contexts.map((c) => c.dispose()))
  }
})

/** What the page saw, kept on `window` by the observers below. */
interface Seen {
  longTasks: number[]
  scripts: string[]
}

/** The part of a `long-animation-frame` entry used here (not in TypeScript's DOM types yet). */
interface LongFrame {
  duration: number
  scripts: { invoker: string; sourceURL: string; duration: number }[]
}

test('no main-thread task over 50 ms while the burndown renders on 2,000 tasks', async ({
  as,
  page,
}) => {
  const owner = inWorkspace(as('owner'), SCALE.workspaceId)
  const sprint = await currentSprint(owner, 'UTC', SCALE)
  const [task] = await query(owner, {
    from: SCALE.folders.backlog,
    where: {
      and: [
        { attribute: SCALE.attr.sprint, op: 'in', value: [sprint.id] },
        { attribute: SCALE.attr.points, op: 'is_not_empty' },
      ],
    },
    limit: 1,
  })
  if (!task) throw new Error('No task with points in the current sprint')
  const points = Number(task.values[SCALE.attr.points])

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(parcelPath(undefined, SCALE))
  const burndown = page.locator('[data-view-block="burndown"]')
  await expect(burndown.getByRole('table')).toBeAttached()
  await expect(page.locator('[data-root-view] [data-live]')).toContainText('Live')
  await expect(page.locator('[data-view-block][data-block-state="loading"]')).toHaveCount(0)

  expect(
    await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')),
  ).toBe(true)
  // Observed from here on: the chart's renders, not loading the app.
  await page.evaluate((longTask) => {
    const seen: Seen = { longTasks: [], scripts: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen.longTasks.push(entry.duration)
    }).observe({ type: 'longtask' })
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
  const frames = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  // The sprint's total moves with the task's points: the burndown reads again and redraws.
  let current = task
  const firstIdeal = burndown.getByRole('row').nth(1).getByRole('cell').nth(1)
  const before = await firstIdeal.textContent()
  try {
    for (const next of [points + 1, points, points + 2, points]) {
      const res = await owner.patch(`/items/${current.id}`, {
        version: current.version,
        values: { [SCALE.attr.points]: next },
      })
      await expectStatus(res, 200)
      current = (await res.json()) as Item
      const total = Number(before) - points + next
      await expect(firstIdeal).toHaveText(String(total))
      await frames()
    }
  } finally {
    if (current.values[SCALE.attr.points] !== points) {
      await owner.patch(`/items/${current.id}`, {
        version: current.version,
        values: { [SCALE.attr.points]: points },
      })
    }
  }
  // The theme (colours come from CSS tokens, D39) and the width (the chart follows its box).
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await frames()
  }
  for (const width of [900, 600, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await frames()
  }

  const { longTasks, scripts } = await page.evaluate(
    () =>
      new Promise<Seen>((resolve) => {
        setTimeout(() => {
          resolve((window as unknown as { seen: Seen }).seen)
        })
      }),
  )
  test.info().annotations.push({
    type: 'burndown',
    description: `long tasks: ${longTasks.length ? longTasks.map((ms) => ms.toFixed(0)).join(', ') + ' ms' : 'none'}`,
  })
  if (scripts.length) {
    test.info().annotations.push({ type: 'in long frames', description: scripts.join('; ') })
  }
  expect(longTasks.filter((ms) => ms > LONG_TASK_MS)).toEqual([])
})
