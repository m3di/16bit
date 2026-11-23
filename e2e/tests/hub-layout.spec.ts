import { expect, test, type Page } from '@playwright/test'

// The hub page's items area fills the viewport below it, and the table scrolls inside it
// (issue 232). Seeded demo hubs: Product's Bugs folder has 300 items, Hiring a handful. Nothing
// here writes.

const BUGS = '/w/demo/hubs/product/product-bugs'
const HIRING = '/w/demo/hubs/hiring'
/** `main` ends with 24px of padding (py-6) under the items area. */
const PAGE_PADDING = 24

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

/** Where the table's scroll box and the items area end, and whether the page itself scrolls. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const bottom = (selector: string) => {
      const el = document.querySelector(selector)
      return el ? el.getBoundingClientRect().bottom + window.scrollY : null
    }
    const box = document.querySelector<HTMLElement>('[data-virtual]')
    return {
      viewport: window.innerHeight,
      page: document.documentElement.scrollHeight,
      area: bottom('[data-items-area]'),
      box: bottom('[data-virtual]'),
      boxScrolls: box ? box.scrollHeight > box.clientHeight : null,
    }
  })
}

/** The items area and the table in it end at the viewport's bottom padding, to the pixel. */
async function expectFillsViewport(page: Page) {
  await expect
    .poll(async () => {
      const l = await layout(page)
      const end = l.viewport - PAGE_PADDING
      return {
        area: l.area !== null && Math.abs(end - l.area) <= 1,
        box: l.box !== null && Math.abs(end - l.box) <= 1,
      }
    })
    .toEqual({ area: true, box: true })
}

async function open(page: Page, path: string, heading: string) {
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await expect(page.locator('[data-virtual] tbody tr[data-index]').first()).toBeVisible()
}

for (const [name, viewport] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`at ${name} width, a 300-item folder's table reaches the bottom of the viewport and scrolls inside it`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await open(page, BUGS, 'Bugs')
    await expectFillsViewport(page)
    const l = await layout(page)
    expect(l.boxScrolls).toBe(true)
    // The page itself does not scroll: the table does.
    expect(l.page).toBeLessThanOrEqual(viewport.height)
  })

  test(`at ${name} width, a folder with few items still has a full-height area`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await open(page, HIRING, 'Hiring')
    await expectFillsViewport(page)
    expect((await layout(page)).page).toBeLessThanOrEqual(viewport.height)
  })
}

test('the table keeps reaching the bottom with the item panel open', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await open(page, BUGS, 'Bugs')
  await page.locator('[data-item-link]').first().click()
  await expect(page.locator('[data-item-panel]')).toBeVisible()
  await expectFillsViewport(page)
})

test('at phone width with the item panel open, the table still reaches the bottom and the panel follows it', async ({
  page,
}) => {
  await page.setViewportSize(PHONE)
  await open(page, BUGS, 'Bugs')
  await page.locator('[data-item-link]').first().click()
  const panel = page.locator('[data-item-panel]')
  await expect(panel).toBeVisible()
  // Measured in page coordinates: opening the panel scrolls the page down to it.
  await expectFillsViewport(page)
  const panelTop = await panel.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
  const { box } = await layout(page)
  // The panel stacks under the items area, after main's bottom padding.
  expect(panelTop).toBeGreaterThanOrEqual((box ?? Infinity) + PAGE_PADDING - 1)
})

test('the table follows the window when it is resized', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await open(page, BUGS, 'Bugs')
  await expectFillsViewport(page)
  await page.setViewportSize({ width: 1280, height: 1100 })
  await expectFillsViewport(page)
  // Rows fill the taller box: still fewer than 100 in the DOM (D61).
  expect(await page.locator('[data-virtual] tbody tr[data-index]').count()).toBeLessThan(100)
})

// At desktop width a long item scrolls inside the panel, and the page stays put with the table
// in view (issue 238). The Large hub's items have every M1 type, so the panel is taller than
// the viewport. Needs `pnpm seed:large`, as large-folder.spec.ts does.
const LARGE = '/w/large/hubs/large/large-items'

/** The panel's scroll box, the page's scroll position, and where the table's header is. */
async function panelLayout(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-item-panel-scroll]')
    const header = document.querySelector('[data-virtual] thead')
    return {
      pageScroll: window.scrollY,
      page: document.documentElement.scrollHeight,
      panelBottom: box ? box.getBoundingClientRect().bottom : null,
      panelScrollTop: box ? box.scrollTop : null,
      panelScrolls: box ? box.scrollHeight > box.clientHeight : null,
      headerTop: header ? header.getBoundingClientRect().top : null,
    }
  })
}

async function openLongItem(page: Page) {
  await open(page, LARGE, 'All items')
  await page.locator('[data-item-link]').first().click()
  await expect(page.locator('[data-item-panel] [data-item-version]')).toBeVisible()
}

test('at desktop width, a long item scrolls inside the panel and the page does not scroll', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP)
  await openLongItem(page)
  await expectFillsViewport(page)
  const l = await panelLayout(page)
  expect(l.panelScrolls).toBe(true)
  expect(l.page).toBeLessThanOrEqual(DESKTOP.height)
  expect(l.panelBottom).toBeLessThanOrEqual(DESKTOP.height)

  // The wheel over the panel scrolls the panel, not the page.
  await page.locator('[data-item-panel] h2').hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(async () => (await panelLayout(page)).panelScrollTop).toBeGreaterThan(0)
  const after = await panelLayout(page)
  expect(after.pageScroll).toBe(0)
  expect(after.headerTop).toBeGreaterThanOrEqual(0)
})

test('at desktop width, tabbing to a lower field scrolls the panel, not the page', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP)
  await openLongItem(page)
  // Opening by click puts focus on the panel's heading; Tab goes on through its fields.
  await expect(page.locator('[data-item-panel] h2')).toBeFocused()
  for (let i = 0; i < 60 && ((await panelLayout(page)).panelScrollTop ?? 0) === 0; i++)
    await page.keyboard.press('Tab')
  const l = await panelLayout(page)
  expect(l.panelScrollTop).toBeGreaterThan(0)
  expect(l.pageScroll).toBe(0)
  expect(l.headerTop).toBeGreaterThanOrEqual(0)
  // The control that took focus is in the panel and in view.
  const focused = await page.evaluate(() => {
    const el = document.activeElement
    const r = el?.getBoundingClientRect()
    return {
      inPanel: !!el?.closest('[data-item-panel]'),
      inView: !!r && r.top >= 0 && r.bottom <= window.innerHeight,
    }
  })
  expect(focused).toEqual({ inPanel: true, inView: true })
})

test('at phone width, a long item still stacks under the table and the page scrolls to it', async ({
  page,
}) => {
  await page.setViewportSize(PHONE)
  await openLongItem(page)
  await expectFillsViewport(page)
  // No scroll box of its own: the panel is as tall as its content.
  expect((await panelLayout(page)).panelScrolls).toBe(false)
  expect((await layout(page)).page).toBeGreaterThan(PHONE.height)
})
