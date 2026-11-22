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

test('the table follows the window when it is resized', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await open(page, BUGS, 'Bugs')
  await expectFillsViewport(page)
  await page.setViewportSize({ width: 1280, height: 1100 })
  await expectFillsViewport(page)
  // Rows fill the taller box: still fewer than 100 in the DOM (D61).
  expect(await page.locator('[data-virtual] tbody tr[data-index]').count()).toBeLessThan(100)
})
