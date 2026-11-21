import type { Locator, Page } from '@playwright/test'
import { expect, hubPath, itemsTable, test } from '../support/roles.ts'

// Sorting the hub table by an indexed column (#52, #73), its sort cue, windows read in a sorted
// order, and a window refused in a sorted order (#85, D61). Product has 1,200 seeded items and indexed
// Stage, Points and Due. Ivy is a viewer there: sorting is reading, so it works read-only.
// Nothing here writes, so other specs adding items to Product can't break the order checks.

function header(page: Page, name: string): Locator {
  return itemsTable(page, 'Product').getByRole('columnheader', { name })
}

/** The Points cells, in row order, as numbers; empty cells as null. */
async function points(page: Page): Promise<(number | null)[]> {
  const table = itemsTable(page, 'Product')
  const names = await table.getByRole('columnheader').allInnerTexts()
  const index = names.findIndex((n) => n.trim() === 'Points')
  expect(index).toBeGreaterThan(-1)
  const texts = await table
    .getByRole('row')
    .filter({ has: page.getByRole('cell') })
    .evaluateAll((rows, i) => rows.map((r) => r.children[i]?.textContent.trim() ?? ''), index)
  return texts.map((t) => (t === '' ? null : Number(t.replace(/,/g, ''))))
}

function expectOrdered(values: (number | null)[], direction: 'asc' | 'desc') {
  const numbers = values.filter((v): v is number => v !== null)
  const sorted = [...numbers].sort((a, b) => (direction === 'asc' ? a - b : b - a))
  expect(numbers).toEqual(sorted)
  // Empty values sit together at one end, never between numbers.
  const firstNumber = values.findIndex((v) => v !== null)
  const lastNumber = values.length - 1 - [...values].reverse().findIndex((v) => v !== null)
  expect(values.slice(firstNumber, lastNumber + 1)).not.toContain(null)
}

async function settled(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: 'Sorting…' })).toHaveCount(0)
}

test('sortable headers show their cue, and sort ascending, descending, then back to default', async ({
  pageAs,
}) => {
  const page = await pageAs('ivy')
  await page.goto(hubPath('product'))
  const pointsHeader = header(page, 'Points')
  const button = pointsHeader.getByRole('button', { name: 'Points' })
  await expect(button).toBeVisible()

  // At rest: sortable, not sorted.
  await expect(pointsHeader).not.toHaveAttribute('aria-sort')
  await expect(pointsHeader.locator('[data-sort-icon]')).toHaveAttribute('data-sort-icon', 'none')
  // Title isn't indexed in Product, so its header is not a button.
  await expect(header(page, 'Title').getByRole('button')).toHaveCount(0)

  await button.click()
  await expect(pointsHeader).toHaveAttribute('aria-sort', 'ascending')
  await expect(pointsHeader.locator('[data-sort-icon]')).toHaveAttribute(
    'data-sort-icon',
    'ascending',
  )
  await settled(page)
  expectOrdered(await points(page), 'asc')

  await button.click()
  await expect(pointsHeader).toHaveAttribute('aria-sort', 'descending')
  await expect(pointsHeader.locator('[data-sort-icon]')).toHaveAttribute(
    'data-sort-icon',
    'descending',
  )
  await settled(page)
  expectOrdered(await points(page), 'desc')

  await button.click()
  await expect(pointsHeader).not.toHaveAttribute('aria-sort')
  await expect(pointsHeader.locator('[data-sort-icon]')).toHaveAttribute('data-sort-icon', 'none')
  await settled(page)
})

/** Scrolls the table's own box so that row `index` is near the top. */
async function scrollTo(page: Page, index: number) {
  await page.locator('[data-virtual]').evaluate((el, top) => {
    el.scrollTop = top
  }, index * 38)
}

async function loaded(page: Page) {
  await expect(itemsTable(page, 'Product').locator('tbody tr[data-placeholder]')).toHaveCount(0)
}

test('scrolling past the first window keeps the sorted order', async ({ pageAs }) => {
  const page = await pageAs('ivy')
  await page.goto(hubPath('product'))
  await header(page, 'Points').getByRole('button', { name: 'Points' }).click()
  await expect(header(page, 'Points')).toHaveAttribute('aria-sort', 'ascending')
  await settled(page)

  // Rows 190 to 220 come from two windows of 200, both read in the sorted order (D61).
  await scrollTo(page, 190)
  await expect(itemsTable(page, 'Product').locator('tbody tr[data-index="200"]')).toBeAttached()
  await loaded(page)
  expectOrdered(await points(page), 'asc')
  const ids = await itemsTable(page, 'Product')
    .getByRole('link', { name: /^PRD-\d+$/ })
    .allInnerTexts()
  expect(new Set(ids).size).toBe(ids.length)
  await expect(header(page, 'Points')).toHaveAttribute('aria-sort', 'ascending')
})

test('a window refused in a sorted order shows the default order, and says why', async ({
  pageAs,
}) => {
  const page = await pageAs('ivy')
  // Points stops being indexed between two windows. The seed can't un-index an attribute, so
  // the server's answer to that window is stood in for here, with the body the API sends for a
  // sort on an attribute that isn't indexed.
  await page.route('**/v1/workspaces/demo/query', async (route) => {
    const body = route.request().postDataJSON() as { offset?: number; sort?: unknown[] }
    if (!body.offset || !body.sort?.length) return route.fallback()
    return route.fulfill({
      status: 400,
      json: {
        error: 'invalid_request',
        message: 'Invalid query',
        errors: [
          {
            path: 'sort.0.attribute',
            message:
              'Attribute "product-points" is not indexed; only indexed attributes can be filtered or sorted',
          },
        ],
      },
    })
  })

  await page.goto(hubPath('product'))
  await header(page, 'Points').getByRole('button', { name: 'Points' }).click()
  await expect(header(page, 'Points')).toHaveAttribute('aria-sort', 'ascending')
  await settled(page)
  await scrollTo(page, 250)

  await expect(
    page.getByText(
      'The table can no longer be sorted by that column, so the items are shown newest first.',
    ),
  ).toBeVisible()
  await expect(header(page, 'Points')).not.toHaveAttribute('aria-sort')
  await expect(header(page, 'Points').locator('[data-sort-icon]')).toHaveAttribute(
    'data-sort-icon',
    'none',
  )
  // The default order loads from the top, and further windows load in it.
  await expect(itemsTable(page, 'Product').locator('tbody tr[data-index="0"]')).toHaveAttribute(
    'data-row',
    '',
  )
  await scrollTo(page, 250)
  await expect(itemsTable(page, 'Product').locator('tbody tr[data-index="250"]')).toHaveAttribute(
    'data-row',
    '',
  )
})
