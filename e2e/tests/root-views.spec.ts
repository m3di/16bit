import type { Item } from '@16bit/core'
import type { Page, Response } from '@playwright/test'
import {
  addWeekdays,
  currentSprint,
  dateOf,
  expectViewMatches,
  getView,
  PARCEL,
  parcelAgentSecret,
  parcelPath,
  readBlock,
  sprintDay,
  todayIn,
} from './support/project.ts'
import { expect, expectStatus, test, uniqueTitle, type Client } from './support/roles.ts'

// Root views (D76 to D83) and the M4 exit check (docs/ROADMAP.md, issue 263): "the project home
// and my work mockups are built as real root views from real data". `pnpm seed` gives the Parcel
// Tracker hub in `demo` two stored views, Home (which the hub opens on) and My work, both in
// views-only folders, and the Backlog folder no view.
//
// Every block is checked against `POST /aggregate` and `POST /query` for its own binding, as the
// person signed in (support/project.ts), and a few against numbers worked out from the seed
// data (apps/api/src/project-seed.ts). The browser runs in UTC, as the seed picks its day in
// UTC (D81), and "day N of 10" is worked out from the stored sprint dates.
//
// The live and composer tests write to the seeded hub and put it back as they found it, so this
// file runs in one worker, in order: no other test reads the hub while one of them has it.
// Removing an attribute is checked on a hub of its own (root-view-blocks.spec.ts), and the
// timing budgets on the production build (project-home-budgets.spec.ts).

test.describe.configure({ mode: 'default' })
// A step that can't happen fails within 10 s, so the tests that write always have time to put
// the hub back.
test.use({ timezoneId: 'UTC', actionTimeout: 10_000 })

const TZ = 'UTC'
const HUB = parcelPath()
const { folders: F, attr: A } = PARCEL
/** How soon after an agent's write both browsers must show it (M4-12). */
const LIVE_MS = 2_000

// The measured numbers, in the CI log as well as on the report.
// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
test.afterEach(({}, testInfo) => {
  const lines = testInfo.annotations
    .filter((a) => a.description)
    .map((a) => `  ${a.type}: ${a.description ?? ''}`)
  if (lines.length) console.log([`[measured] ${testInfo.title}`, ...lines].join('\n'))
})

const viewData = (r: Response, folder: string) =>
  r.request().method() === 'GET' &&
  new URL(r.url()).pathname.endsWith(`/folders/${folder}/view/data`)

/** Every block in a view-data answer, by status. */
async function statuses(response: Response) {
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { blocks: Record<string, { status: string }> }
  return Object.values(body.blocks).map((b) => b.status)
}

/** The page is subscribed to the hub's changes. */
async function live(page: Page) {
  await expect(page.locator('[data-root-view] [data-live]')).toContainText('Live')
}

/** Every data block has loaded and none is in an error state. */
async function allReady(page: Page) {
  await expect(page.locator('[data-view-block]').first()).toBeVisible()
  await expect(page.locator('[data-view-block][data-block-state="loading"]')).toHaveCount(0)
  await expect(page.locator('[data-block-state="error"], [data-block-broken]')).toHaveCount(0)
}

const block = (page: Page, id: string) => page.locator(`[data-view-block="${id}"]`)

/** A number block's value, as shown. */
async function numberValue(page: Page, id: string) {
  const shown = await readBlock(page, id)
  return shown && 'number' in shown ? shown.number.value : null
}

async function deleteItem(client: Client, id: string) {
  const res = await client.get(`/items/${id}`)
  if (res.status() === 404) return
  const { version } = (await res.json()) as Item
  await expectStatus(await client.delete(`/items/${id}?version=${String(version)}`), 204)
}

test('the hub opens on its stored Home view, whose blocks are read from real data', async ({
  page,
}) => {
  const data = page.waitForResponse((r) => viewData(r, F.home))
  await page.goto(HUB)
  await expect(page.getByRole('heading', { level: 1, name: 'Parcel Tracker v2' })).toBeVisible()
  const blocks = await statuses(await data)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks.every((s) => s === 'ok')).toBe(true)
  await expect(page.locator('[data-block-state="ready"]').first()).toBeVisible()
  await expect(page.locator('[data-block-state="error"]')).toHaveCount(0)
})

test('My work is a stored view too, read for the signed-in person', async ({ page }) => {
  const data = page.waitForResponse((r) => viewData(r, F.work))
  await page.goto(`${HUB}/${F.work}`)
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible()
  const blocks = await statuses(await data)
  expect(blocks.every((s) => s === 'ok')).toBe(true)
})

test('a folder with no stored view reads its items without waiting for its view', async ({
  page,
}) => {
  // Hold the view's answer: the items query must still go out.
  let answer: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    answer = resolve
  })
  await page.route(`**/v1/workspaces/demo/folders/${F.backlog}/view`, async (route) => {
    await held
    await route.continue()
  })
  const query = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/v1/workspaces/demo/query',
  )
  await page.goto(`${HUB}/${F.backlog}`)
  await query
  answer()
  await expect(page.getByRole('heading', { level: 1, name: 'Backlog' })).toBeVisible()
  await expect(page.locator('[data-virtual] tbody tr[data-index]').first()).toBeVisible()
})

test('project home: every block shows what /aggregate and /query answer, and the seed numbers', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  await page.goto(HUB)
  await allReady(page)
  await expectViewMatches(page, owner, F.home)

  // Literal values from the seed data (project-seed.ts `sampleTasks`).
  const sprint = await currentSprint(owner, TZ)
  const start = dateOf(sprint.values[A.start])
  const end = dateOf(sprint.values[A.end])
  const { day, of } = sprintDay(start, end, todayIn(TZ))
  expect(of).toBe(10)
  expect(await readBlock(page, 'sprint')).toMatchObject({
    fields: [
      ['Title', 'Sprint 24'],
      ['Start', expect.any(String)],
      ['End', expect.any(String)],
    ],
  })
  expect(await numberValue(page, 'sprint-day')).toBe(`${String(day)} of 10`)
  expect(await numberValue(page, 'points-done')).toBe('16 of 34')
  expect(await numberValue(page, 'in-review')).toBe('2')
  expect(await numberValue(page, 'open-bugs')).toBe('7')
  // Seven rows, the unestimated chore PT-216 among them (a known difference from the mockup).
  await expect(block(page, 'current-work-list').getByRole('listitem')).toHaveCount(7)
  await expect(block(page, 'current-work-list')).toContainText('Review the live map PR')
  // Team: open points by owner, only owners with open items (Sara 5 + 5, Tomas 8).
  expect(await readBlock(page, 'team-points')).toMatchObject({
    groups: [
      { label: 'Sara Lind', measures: '10 points' },
      { label: 'Tomas Berg', measures: '8 points' },
    ],
  })
  // Release bars: done of all items per epic (D82), 11 of 13, 9 of 14 and 4 of 9.
  expect(await readBlock(page, 'epic-bars')).toMatchObject({
    bars: expect.arrayContaining([
      'Courier tools: 11 of 13',
      'Tracking page: 9 of 14',
      'Notifications: 4 of 9',
    ]),
  })
  // The burndown starts at the sprint's 34 points and has one row per weekday.
  const burndown = await readBlock(page, 'burndown')
  if (!burndown || !('burndown' in burndown)) throw new Error('No burndown')
  expect(burndown.burndown.ideal[0]).toBe('34')
  expect(burndown.burndown.left).toHaveLength(10)
})

test('my work is each reader’s own: Sara and Tomas see their own sprint and numbers', async ({
  as,
  pageAs,
}) => {
  const sara = await pageAs('sara')
  const tomas = await pageAs('tomas')
  await Promise.all([sara.goto(`${HUB}/${F.work}`), tomas.goto(`${HUB}/${F.work}`)])
  await Promise.all([allReady(sara), allReady(tomas)])
  await expectViewMatches(sara, as('sara'), F.work)
  await expectViewMatches(tomas, as('tomas'), F.work)

  // Sara: 214 and 217 open, 5 points each; 216 has none. Tomas: 215, 8 points, in review.
  expect(await numberValue(sara, 'my-points')).toBe('10')
  expect(await numberValue(tomas, 'my-points')).toBe('8')
  const board = (page: Page) => block(page, 'my-board')
  await expect(board(sara)).toContainText('Delivery window picker')
  await expect(board(sara)).toContainText('Nothing of yours is in review.')
  await expect(board(sara)).not.toContainText('Live map on tracking page')
  await expect(board(tomas)).toContainText('Live map on tracking page')
  await expect(board(tomas)).not.toContainText('Delivery window picker')
  // The backlog is the same for both: Next up 19 points, Later one not estimated.
  for (const page of [sara, tomas]) {
    expect(await readBlock(page, 'backlog-list')).toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({
          label: 'Next up',
          measures: expect.stringContaining('19 points'),
        }),
        expect.objectContaining({
          label: 'Later',
          measures: expect.stringContaining('1 without points'),
        }),
      ]),
    })
  }
})

test('a viewer sees both views as they are, with no New item anywhere', async ({ as, pageAs }) => {
  const ivy = await pageAs('ivy')
  for (const folder of [F.home, F.work]) {
    await ivy.goto(`${HUB}/${folder}`)
    await allReady(ivy)
    await expectViewMatches(ivy, as('ivy'), folder)
    await expect(ivy.getByRole('button', { name: /^New item/ })).toHaveCount(0)
  }
})

test('New item in My work creates in Backlog with the group preset, and the view shows it', async ({
  as,
  pageAs,
}) => {
  const sara = await pageAs('sara')
  await sara.goto(`${HUB}/${F.work}`)
  await allReady(sara)
  await live(sara)
  const title = uniqueTitle('next up')
  let created: string | null = null
  try {
    await block(sara, 'backlog-list').getByRole('button', { name: 'New item in Next up' }).click()
    const form = sara.getByRole('complementary', { name: 'New item', exact: true })
    await form.getByLabel('Title', { exact: true }).fill(title)
    await form.getByRole('button', { name: 'Create item' }).click()
    // The page stays on the view, with the new item open in the panel.
    await expect(sara).toHaveURL(/\?item=/)
    created = new URL(sara.url()).searchParams.get('item')
    const item = (await (await as('sara').get(`/items/${created ?? ''}`)).json()) as Item
    expect(item.folderId).toBe(F.backlog)
    expect(item.values).toEqual({ [A.title]: title, [A.bucket]: 'next-up' })
    await expect
      .poll(async () => {
        const shown = await readBlock(sara, 'backlog-list')
        const group =
          shown && 'groups' in shown ? shown.groups.find((g) => g.label === 'Next up') : null
        return group?.rows.some((r) => r.startsWith(title)) ?? false
      })
      .toBe(true)
    await expectViewMatches(sara, as('sara'), F.work)
  } finally {
    if (created) await deleteItem(as('owner'), created)
  }
})

test('New item on the My work board presets only the column’s Stage', async ({ as, pageAs }) => {
  const sara = await pageAs('sara')
  await sara.goto(`${HUB}/${F.work}`)
  await allReady(sara)
  await live(sara)
  const title = uniqueTitle('board')
  let created: string | null = null
  try {
    await block(sara, 'my-board').getByRole('button', { name: 'New item in In progress' }).click()
    const form = sara.getByRole('complementary', { name: 'New item', exact: true })
    await form.getByLabel('Title', { exact: true }).fill(title)
    await form.getByRole('button', { name: 'Create item' }).click()
    await expect(sara).toHaveURL(/\?item=/)
    created = new URL(sara.url()).searchParams.get('item')
    const item = (await (await as('sara').get(`/items/${created ?? ''}`)).json()) as Item
    // The board's filter is a sprint `in` and an `or` over Owner and Reviewer: neither is an
    // `AND` equality, so only the column's value is filled in (D77).
    expect(item.folderId).toBe(F.backlog)
    expect(item.values).toEqual({ [A.title]: title, [A.stage]: 'in-progress' })
    // No sprint, so not on the board; in the backlog list, which has every item with no sprint.
    await expect(block(sara, 'backlog-list')).toContainText(title)
    await expect(block(sara, 'my-board')).not.toContainText(title)
  } finally {
    if (created) await deleteItem(as('owner'), created)
  }
})

test('an agent key cannot create items in a views-only folder', async ({ bearer }) => {
  const agent = await bearer(parcelAgentSecret())
  for (const folderId of [F.home, F.work]) {
    const res = await agent.post('/items', {
      folderId,
      values: { [A.title]: uniqueTitle('views only') },
    })
    await expectStatus(res, 422)
    expect(await res.json()).toMatchObject({ error: 'views_only' })
  }
  // The same key can create in Backlog: the refusal is the folder's, not the key's.
  const ok = await agent.post('/items', {
    folderId: F.backlog,
    values: { [A.title]: uniqueTitle('backlog') },
  })
  await expectStatus(ok, 201)
  const item = (await ok.json()) as Item
  await expectStatus(await agent.delete(`/items/${item.id}?version=${String(item.version)}`), 204)
})

test('two tabs of the same person both render Home with no error state', async ({
  as,
  context,
  page,
}) => {
  const second = await context.newPage()
  await Promise.all([page.goto(HUB), second.goto(HUB)])
  for (const tab of [page, second]) {
    await allReady(tab)
    await expect(tab.locator('[data-view-problem]')).toHaveCount(0)
    await expectViewMatches(tab, as('owner'), F.home)
  }
})

test('screenshots of Home and My work in both themes, for the M4 exit', async ({
  pageAs,
}, testInfo) => {
  for (const theme of ['light', 'dark'] as const) {
    const sara = await pageAs('sara', { width: 1280, height: 900 })
    await sara.emulateMedia({ colorScheme: theme })
    for (const [name, folder] of [
      ['home', F.home],
      ['my-work', F.work],
    ] as const) {
      await sara.goto(`${HUB}/${folder}`)
      await allReady(sara)
      await live(sara)
      await expect(sara.locator('html')).toHaveClass(`theme-${theme}`)
      const path = testInfo.outputPath(`m4-${name}-${theme}.png`)
      await sara.screenshot({ path, fullPage: true, animations: 'disabled' })
      await testInfo.attach(`m4-${name}-${theme}`, { path, contentType: 'image/png' })
    }
  }
})

test('an agent key’s writes over HTTP reach both browsers within 2 s', async ({
  as,
  bearer,
  page,
  pageAs,
}) => {
  const agent = await bearer(parcelAgentSecret())
  const owner = as('owner')
  const sara = await pageAs('sara')
  await Promise.all([page.goto(HUB), sara.goto(`${HUB}/${F.work}`)])
  await Promise.all([allReady(page), allReady(sara), live(page), live(sara)])

  const sprint = await currentSprint(owner, TZ)
  const end = dateOf(sprint.values[A.end])
  /** Both browsers agree with the API within 2 s of the write that ended at `since`. */
  const measured: string[] = []
  const bothAgree = async (what: string, since: number) => {
    const ms = await Promise.all([
      expectViewMatches(page, owner, F.home, { timeout: LIVE_MS, since }),
      expectViewMatches(sara, as('sara'), F.work, { timeout: LIVE_MS, since }),
    ])
    measured.push(`${what} ${ms.map((n) => n.toFixed(0)).join('/')} ms`)
  }
  const patch = async (item: Item, values: Record<string, unknown>) => {
    const res = await agent.patch(`/items/${item.id}`, { version: item.version, values })
    await expectStatus(res, 200)
    return (await res.json()) as Item
  }

  let task: Item | null = null
  let sprintNow = sprint
  try {
    // A create: a new card in Sara's To do, 3 more points in the sprint.
    const title = uniqueTitle('agent task')
    const res = await agent.post('/items', {
      folderId: F.backlog,
      values: {
        [A.title]: title,
        [A.type]: 'story',
        [A.stage]: 'to-do',
        [A.owner]: ['sara'],
        [A.points]: 3,
        [A.sprint]: [sprint.id],
      },
    })
    await expectStatus(res, 201)
    task = (await res.json()) as Item
    await bothAgree('create', Date.now())
    expect(await numberValue(page, 'points-done')).toBe('16 of 37')
    expect(await numberValue(sara, 'my-points')).toBe('13')

    // A patch: the card moves to In review, the numbers follow.
    task = await patch(task, { [A.stage]: 'in-review' })
    await bothAgree('patch to In review', Date.now())
    expect(await numberValue(page, 'in-review')).toBe('3')
    expect(await readBlock(sara, 'my-board')).toMatchObject({
      columns: expect.arrayContaining([
        expect.objectContaining({ label: 'In review', cards: [`${title} | 3`] }),
      ]),
    })

    // Done today: points done, the burndown's today and Sara's team row move.
    task = await patch(task, { [A.stage]: 'done', [A.doneOn]: todayIn(TZ) })
    await bothAgree('done today', Date.now())
    expect(await numberValue(page, 'points-done')).toBe('19 of 37')
    expect(await readBlock(page, 'team-points')).toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({ label: 'Sara Lind', measures: '10 points' }),
      ]),
    })
    await expect(block(sara, 'my-board')).not.toContainText(title)

    // A delete: gone from both.
    await expectStatus(await agent.delete(`/items/${task.id}?version=${String(task.version)}`), 204)
    task = null
    await bothAgree('delete', Date.now())
    expect(await numberValue(page, 'points-done')).toBe('16 of 34')
    await expect(block(page, 'current-work-list')).not.toContainText(title)

    // Editing the sprint's dates refetches the burndown and the sprint's day count.
    sprintNow = await patch(sprint, { [A.end]: addWeekdays(end, 1) })
    await bothAgree('sprint dates', Date.now())
    expect(await numberValue(page, 'sprint-day')).toMatch(/ of 11$/)
    const burndown = await readBlock(page, 'burndown')
    if (burndown && 'burndown' in burndown) expect(burndown.burndown.left).toHaveLength(11)
  } finally {
    test.info().annotations.push({
      type: 'Home and My work agreed with the API after',
      description: measured.join(', '),
    })
    if (task) await deleteItem(owner, task.id)
    if (sprintNow.values[A.end] !== end) {
      const current = (await (await owner.get(`/items/${sprint.id}`)).json()) as Item
      await expectStatus(
        await owner.patch(`/items/${sprint.id}`, {
          version: current.version,
          values: { [A.end]: end },
        }),
        200,
      )
    }
  }
})

/** The composer's form for the block selected in its outline. */
const blockForm = (page: Page, type: string) =>
  page.getByRole('region', { name: `${type} settings`, exact: true })

/** Types a filter into a form's "Edit as JSON" and applies it. */
async function filterAsJson(form: ReturnType<typeof blockForm>, filter: unknown) {
  const group = form.getByRole('group', { name: 'Filter', exact: true })
  await group.getByRole('button', { name: 'Edit as JSON' }).click()
  const box = group.getByLabel('Filter as JSON')
  await box.fill(JSON.stringify(filter))
  await box.blur()
}

/** Selects the page, the root of the composer's outline. */
const selectPage = (page: Page) =>
  page.locator('[data-outline-block="page"] [data-outline-select]').first().click()

/** Adds a block of `type` to the page and selects it. */
async function addToPage(page: Page, type: string) {
  await selectPage(page)
  await page.getByLabel('Add to Page').selectOption({ label: type })
  await page.getByRole('button', { name: 'Add block' }).click()
  await expect(blockForm(page, type)).toBeVisible()
}

test('a hub admin builds My work in the composer from the default view; a stale tab gets the 409', async ({
  as,
  context,
  page,
  pageAs,
}) => {
  // Long enough that the view is always put back, whatever step fails.
  test.setTimeout(120_000)
  const owner = as('owner')
  const seeded = await getView(owner, F.work)
  const me = [{ $me: true }]
  try {
    // From the default: the seeded view is reset, and the folder has none.
    if (seeded.stored) {
      await expectStatus(
        await owner.delete(`/folders/${F.work}/view?version=${String(seeded.version)}`),
        204,
      )
    }
    await page.goto(`${HUB}/${F.work}`)
    await expect(page.getByText('No view yet')).toBeVisible()
    await page.getByRole('link', { name: 'Compose' }).click()
    await expect(page).toHaveURL(/\/settings\/views/)
    await expect(page.getByLabel('Folder')).toHaveValue(F.work)

    // The page, titled; a number of my open points; my board by stage with points on cards.
    await blockForm(page, 'Page').getByLabel('Title').fill('My work')
    await addToPage(page, 'Number')
    const number = blockForm(page, 'Number')
    await number.getByLabel('Label').fill('My open points')
    await number.getByLabel('Items from').selectOption({ label: 'Backlog' })
    await number.getByLabel('Value: of').selectOption({ label: 'Points' })
    await number.getByLabel('Value: summary').selectOption({ label: 'Sum' })
    await filterAsJson(number, {
      and: [
        { attribute: A.owner, op: 'in', value: me },
        { attribute: A.stage, op: 'not_in', value: ['done'] },
      ],
    })
    await addToPage(page, 'Board')
    const board = blockForm(page, 'Board')
    await board.getByLabel('Items from').selectOption({ label: 'Backlog' })
    await filterAsJson(board, {
      or: [
        { attribute: A.owner, op: 'in', value: me },
        { attribute: A.reviewer, op: 'in', value: me },
      ],
    })
    await board.getByLabel('Columns from').selectOption({ label: 'Stage' })
    await board.getByRole('checkbox', { name: 'Done', exact: true }).uncheck()
    await board.getByRole('button', { name: 'Add field' }).click()
    await board.getByLabel('Field 1', { exact: true }).selectOption({ label: 'Points' })
    await board.getByLabel('Field 1 when empty').fill('?')
    await board.getByRole('checkbox', { name: 'Offer “New item”' }).check()

    // Saved, it renders: Sara's own numbers and cards, as the API has them.
    await page.getByRole('button', { name: 'Save view' }).click()
    await expect(page.locator('[data-composer-state]')).toHaveText('')
    await expect.poll(async () => (await getView(owner, F.work)).stored).toBe(true)
    const saved = await getView(owner, F.work)
    expect(saved.tree.root.children?.map((b) => b.type)).toEqual(['number', 'board'])
    const sara = await pageAs('sara')
    await sara.goto(`${HUB}/${F.work}`)
    await expect(sara.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible()
    await allReady(sara)
    await expectViewMatches(sara, as('sara'), F.work)
    expect(await readBlock(sara, saved.tree.root.children?.[0]?.id ?? '')).toMatchObject({
      number: { label: 'My open points', value: '10' },
    })
    await expect(sara.getByRole('button', { name: 'New item in In progress' })).toBeVisible()

    // Two tabs of the composer: the second saves over a version that moved, and is told so.
    const first = page
    const second = await context.newPage()
    await second.goto(`${HUB}/settings/views`)
    await second.getByLabel('Folder').selectOption({ label: '– My work (views only)' })
    await expect(blockForm(second, 'Page').getByLabel('Title')).toHaveValue('My work')
    await selectPage(first)
    await blockForm(first, 'Page').getByLabel('Title').fill('My work, first tab')
    await first.getByRole('button', { name: 'Save view' }).click()
    await expect.poll(async () => (await getView(owner, F.work)).version).toBe(saved.version + 1)
    await blockForm(second, 'Page').getByLabel('Title').fill('My work, second tab')
    await second.getByRole('button', { name: 'Save view' }).click()
    const notice = second.locator('[data-composer-notice]')
    await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible()
    expect((await getView(owner, F.work)).tree.root.config).toEqual({ title: 'My work, first tab' })
    // The API answers a stale version with 409 too.
    await expectStatus(
      await owner.put(`/folders/${F.work}/view`, { version: saved.version, tree: saved.tree }),
      409,
    )
    await notice.getByRole('button', { name: 'Reload' }).click()
    await expect(blockForm(second, 'Page').getByLabel('Title')).toHaveValue('My work, first tab')

    // An editor and a viewer get no composer, and the API refuses them.
    for (const person of ['sara', 'ivy'] as const) {
      const other = await pageAs(person)
      await other.goto(`${HUB}/settings/views`)
      await expect(other.getByText('Only hub admins can compose root views')).toBeVisible()
      await expect(other.getByRole('button', { name: 'Save view' })).toHaveCount(0)
      const current = await getView(owner, F.work)
      await expectStatus(
        await as(person).put(`/folders/${F.work}/view`, {
          version: current.version,
          tree: seeded.tree,
        }),
        403,
      )
    }
  } finally {
    // Back to the seeded view, for the rest of the suite and the next run.
    const now = await getView(owner, F.work)
    await expectStatus(
      await owner.put(`/folders/${F.work}/view`, {
        version: now.stored ? now.version : 0,
        tree: seeded.tree,
      }),
      200,
    )
  }
})
