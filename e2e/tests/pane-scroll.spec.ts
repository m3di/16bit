import { type Locator, type Page } from '@playwright/test'
import { demo, expect, test, uniqueTitle } from './support/fixtures.ts'
import { PARCEL, parcelPath } from './support/project.ts'

// From md up the app is a full-height shell: the page never scrolls, the top bar stays put, and
// the sidebar, the main pane and the item panel each scroll on their own. A folder's single
// table fills the main pane and is its only scroller. The table must not contain horizontal
// overscroll, or a trackpad swipe over it can't go back (issue 310, D85).

/** Shorter than the Home view, so its main pane has to scroll. */
const DESKTOP = { width: 1440, height: 640 }
const PHONE = { width: 390, height: 844 }
const BUGS = '/w/demo/hubs/product/product-bugs'

const topBar = (page: Page) => page.locator('[data-top-bar]')
const sidebar = (page: Page) => page.locator('[data-sidebar-pane]')
const mainPane = (page: Page) => page.locator('[data-main-pane]')
const table = (page: Page) => page.locator('[data-virtual]')

async function scrollState(el: Locator) {
  return el.evaluate((node) => ({
    top: node.scrollTop,
    scrolls: node.scrollHeight > node.clientHeight,
  }))
}

/** Where the top bar and the sidebar are on screen, and whether the page itself scrolled. */
async function chrome(page: Page) {
  return {
    topBar: await topBar(page).boundingBox(),
    sidebar: await sidebar(page).boundingBox(),
    pageScroll: await page.evaluate(() => window.scrollY),
  }
}

test('at desktop width, scrolling a root view scrolls the main pane and nothing else', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP)
  await page.goto(parcelPath(PARCEL.folders.home))
  const main = mainPane(page)
  const heading = main.getByRole('heading', { level: 1 }).first()
  await expect(heading).toBeVisible()
  await expect(main.locator('[data-block-state="loading"]')).toHaveCount(0)
  await expect.poll(async () => (await scrollState(main)).scrolls).toBe(true)
  // The page itself has nothing to scroll.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
    DESKTOP.height,
  )
  const before = await chrome(page)
  expect(before.pageScroll).toBe(0)

  await heading.hover()
  await page.mouse.wheel(0, 1500)
  await expect.poll(async () => (await scrollState(main)).top).toBeGreaterThan(0)

  expect(await chrome(page)).toEqual(before)
  await expect(topBar(page)).toBeInViewport()
})

test('at desktop width, a single-table folder fills the main pane and only the table scrolls', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP)
  await page.goto(BUGS)
  await expect(page.getByRole('heading', { level: 1, name: 'Bugs' })).toBeVisible()
  await expect(table(page).locator('tbody tr[data-index]').first()).toBeVisible()

  // No empty space under the table: it ends where the main pane's padding starts.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('[data-main-pane]')
        const box = document.querySelector('[data-virtual]')
        if (!main || !box) return null
        const end =
          main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom)
        return Math.abs(end - box.getBoundingClientRect().bottom) <= 1
      }),
    )
    .toBe(true)
  // The table is the only scroller: the main pane has nothing to scroll.
  expect((await scrollState(mainPane(page))).scrolls).toBe(false)
  expect((await scrollState(table(page))).scrolls).toBe(true)

  const before = await chrome(page)
  const columnHeader = table(page).getByRole('columnheader').first()
  const header = await columnHeader.boundingBox()
  await table(page).locator('tbody tr[data-index]').first().hover()
  await page.mouse.wheel(0, 1500)
  await expect.poll(async () => (await scrollState(table(page))).top).toBeGreaterThan(0)

  expect((await scrollState(mainPane(page))).top).toBe(0)
  expect(await chrome(page)).toEqual(before)
  // The toolbar and the headers stay put.
  expect(await columnHeader.boundingBox()).toEqual(header)
})

test('nothing from the table up contains horizontal overscroll, so swipe-back still works', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP)
  await page.goto(BUGS)
  await expect(table(page).locator('tbody tr[data-index]').first()).toBeVisible()
  const overscroll = await table(page).evaluate((box) => {
    const chain: { el: string; x: string; y: string }[] = []
    for (let el: Element | null = box; el; el = el.parentElement) {
      const style = getComputedStyle(el)
      chain.push({
        el: el.tagName.toLowerCase(),
        x: style.overscrollBehaviorX,
        y: style.overscrollBehaviorY,
      })
    }
    return chain
  })
  // The table's own scroller still keeps vertical scrolling from chaining to the page.
  expect(overscroll[0]?.y).toBe('contain')
  for (const { el, x } of overscroll) expect(x, el).not.toMatch(/^(contain|none)$/)
})

test('at phone width, a failed save in the item sheet is shown and announced inside the sheet', async ({
  api,
  page,
}) => {
  const title = uniqueTitle('sheet notice')
  const item = await api.createItem({ values: { [demo.hub.titleAttributeId]: title } })
  // The server refuses this item's next write.
  await page.route(`**/v1/workspaces/${demo.workspaceId}/items/${item.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal', message: 'Something went wrong.' }),
        })
      : route.fallback(),
  )

  await page.setViewportSize(PHONE)
  await page.goto(`/w/${demo.workspaceId}/hubs/${demo.hub.id}?item=${item.id}`)
  const sheet = page.locator('[data-item-panel]').getByRole('dialog')
  await expect(sheet).toHaveAttribute('aria-modal', 'true')
  const field = sheet.getByLabel('Title (required)')
  await expect(field).toHaveValue(title)

  await field.fill(uniqueTitle('refused'))
  await field.press('Enter')

  const notice = page.locator('[data-sheet-notice]')
  await expect(notice.getByRole('alert')).toContainText(`Your change to`)
  await expect(notice.getByRole('alert')).toContainText('was not saved')
  await expect(notice).toBeInViewport()
  // It is in the sheet, which is not inert, so it is read out.
  expect(await notice.evaluate((el) => el.closest('[inert]') === null)).toBe(true)
  await expect(field).toHaveValue(title)

  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  expect((await api.getItem(item.id)).version).toBe(1)
})
