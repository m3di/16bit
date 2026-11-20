import { expect, test, type Locator, type Page } from '@playwright/test'

// A folder of 50,000 items in the dashboard (D61, issue 176). Needs `pnpm seed:large`: the
// `large` workspace, whose Large hub has the folder "All items" (`large-items`). The owner is
// hub admin there. Nothing here writes, so the folder stays as the seed left it.

const FOLDER = '/w/large/hubs/large/large-items'
const ROW = 38

function table(page: Page): Locator {
  return page.getByRole('table', { name: 'Items in All items' })
}

/** The table's own scroll box. */
function box(page: Page): Locator {
  return page.locator('[data-virtual]')
}

/** Rows rendered in the table body, loaded or not. */
function rendered(page: Page): Locator {
  return table(page).locator('tbody tr[data-index]')
}

async function scrollTo(page: Page, index: number) {
  await box(page).evaluate((el, top) => {
    el.scrollTop = top
  }, index * ROW)
}

/** Waits until every row rendered is loaded, and returns the item numbers they show. */
async function loadedNumbers(page: Page): Promise<number[]> {
  await expect(table(page).locator('tbody tr[data-placeholder]')).toHaveCount(0)
  const ids = await table(page)
    .getByRole('link', { name: /^LRG-\d+$/ })
    .allInnerTexts()
  return ids.map((id) => Number(id.replace('LRG-', '')))
}

const descending = (numbers: number[]) =>
  numbers.every((n, i) => i === 0 || n < (numbers[i - 1] ?? Infinity))

test('opens a 50,000-item folder by item number, newest first, rendering only the rows in view', async ({
  page,
}) => {
  await page.goto(FOLDER)
  await expect(page.getByRole('heading', { name: 'All items', level: 1 })).toBeVisible()
  await expect(page.locator('[data-count]')).toHaveText('50,000 items')
  // The scrollbar is sized by the total, with the header as the first row.
  await expect(table(page)).toHaveAttribute('aria-rowcount', '50001')

  const first = await loadedNumbers(page)
  expect(first.length).toBeGreaterThan(5)
  expect(descending(first)).toBe(true)
  expect(await rendered(page).count()).toBeLessThan(100)
})

test('jumps to the middle and the end, loading the windows there', async ({ page }) => {
  const reads: number[] = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/query')) return
    const body = request.postDataJSON() as { offset?: number; order?: string; count?: boolean }
    expect(body).toMatchObject({ order: 'number', count: true })
    reads.push(body.offset ?? -1)
  })
  await page.goto(FOLDER)
  await loadedNumbers(page)

  await scrollTo(page, 25_000)
  const middle = await loadedNumbers(page)
  expect(descending(middle)).toBe(true)
  await expect(table(page).locator('tbody tr[data-index="25000"]')).toBeVisible()
  expect(await rendered(page).count()).toBeLessThan(100)
  // Windows of 200 rows by offset, each read once.
  expect(reads.every((offset) => offset % 200 === 0)).toBe(true)
  expect(reads).toContain(24_800)

  await scrollTo(page, 50_000)
  await expect(table(page).locator('tbody tr[data-index="49999"]')).toHaveAttribute('data-row', '')
  const end = await loadedNumbers(page)
  expect(descending(end)).toBe(true)
  expect(new Set(reads).size).toBe(reads.length)
})

test('keeps the selected row focused through a wheel scroll, so the arrow keys go on from it', async ({
  page,
}) => {
  await page.goto(FOLDER)
  await loadedNumbers(page)
  // A keyboard user reaches the table's one tab stop and moves down with the arrow keys. The
  // panel opens beside the table and leaves focus on the row.
  await rendered(page).first().focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const third = table(page).locator('tbody tr[data-index="2"]')
  await expect(third).toHaveAttribute('aria-selected', 'true')
  await expect(third).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Item', exact: true })).toBeVisible()

  // Far away by wheel: the selected row leaves the view but stays in the DOM, focused.
  await box(page).hover()
  await page.mouse.wheel(0, 400 * ROW)
  await expect(table(page).locator('tbody tr[data-index="400"]')).toBeAttached()
  await expect(third).toBeFocused()
  await expect(third).not.toBeInViewport()

  await page.keyboard.press('ArrowDown')
  const fourth = table(page).locator('tbody tr[data-index="3"]')
  await expect(fourth).toHaveAttribute('aria-selected', 'true')
  await expect(fourth).toBeFocused()
  await expect(fourth).toBeInViewport()
  await expect(page).toHaveURL(/\?item=large-\d+$/)
})

test('sorts by a column from the windows in view, and reads other windows in that order', async ({
  page,
}) => {
  await page.goto(FOLDER)
  await loadedNumbers(page)
  const effort = table(page).getByRole('columnheader', { name: 'Effort' })
  await effort.getByRole('button', { name: 'Effort' }).click()
  await expect(effort).toHaveAttribute('aria-sort', 'ascending')
  await expect(page.getByRole('status').filter({ hasText: 'Sorting…' })).toHaveCount(0, {
    timeout: 10_000,
  })

  const efforts = async () => {
    await expect(table(page).locator('tbody tr[data-placeholder]')).toHaveCount(0, {
      timeout: 10_000,
    })
    const names = await table(page).getByRole('columnheader').allInnerTexts()
    const column = names.findIndex((n) => n.trim() === 'Effort')
    const texts = await rendered(page).evaluateAll(
      (rows, i) => rows.map((r) => r.children[i]?.textContent.trim() ?? ''),
      column,
    )
    return texts.filter((t) => t !== '').map((t) => Number(t.replace(/,/g, '')))
  }
  const top = await efforts()
  expect(top).toEqual([...top].sort((a, b) => a - b))

  // Across a window edge, deep in the folder, still in Effort order.
  await scrollTo(page, 30_190)
  const deep = await efforts()
  expect(deep).toEqual([...deep].sort((a, b) => a - b))
  expect(deep[0]).toBeGreaterThanOrEqual(top.at(-1) ?? 0)
})

test('fits a phone: the table scrolls inside its own box, never the page sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(FOLDER)
  await loadedNumbers(page)
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(pageWidth).toBeLessThanOrEqual(390)
  expect(await rendered(page).count()).toBeLessThan(100)
})
