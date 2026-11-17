import { DEFAULT_PAGE_LIMIT } from '@16bit/core'
import type { Locator, Page } from '@playwright/test'
import { expect, hubPath, itemsTable, test } from '../support/roles.ts'

// Sorting the hub table by an indexed column (#52, #73), its sort cue, "Load more" in a sorted
// order, and a refused sorted "Load more" (#85). Product has 1,200 seeded items and indexed
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

test('"Load more" keeps the sorted order', async ({ pageAs }) => {
  const page = await pageAs('ivy')
  await page.goto(hubPath('product'))
  await header(page, 'Points').getByRole('button', { name: 'Points' }).click()
  await expect(header(page, 'Points')).toHaveAttribute('aria-sort', 'ascending')
  await settled(page)

  const rows = itemsTable(page, 'Product')
    .getByRole('row')
    .filter({ has: page.getByRole('cell') })
  await expect(rows).toHaveCount(DEFAULT_PAGE_LIMIT)
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(rows).toHaveCount(DEFAULT_PAGE_LIMIT * 2)

  expectOrdered(await points(page), 'asc')
  const ids = await itemsTable(page, 'Product')
    .getByRole('link', { name: /^PRD-\d+$/ })
    .allInnerTexts()
  expect(new Set(ids).size).toBe(ids.length)
  await expect(header(page, 'Points')).toHaveAttribute('aria-sort', 'ascending')
})

test('a refused sorted "Load more" offers the default order, which brings the rest back', async ({
  pageAs,
}) => {
  const page = await pageAs('ivy')
  // Points stops being indexed between two pages. The seed can't un-index an attribute and
  // there is no attribute API in M1, so the server's answer to that page is stood in for here,
  // with the body the API sends for a sort on an attribute that isn't indexed.
  await page.route('**/v1/workspaces/demo/query', async (route) => {
    const body = route.request().postDataJSON() as { cursor?: string | null; sort?: unknown[] }
    if (!body.cursor || !body.sort?.length) return route.fallback()
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
  const before = await points(page)
  await page.getByRole('button', { name: 'Load more' }).click()

  await expect(page.getByText('More items cannot be loaded in this order.')).toBeVisible()
  await expect(page.locator('[data-more-refused]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  // The rows and the order stay as they were.
  expect(await points(page)).toEqual(before)
  await expect(header(page, 'Points')).toHaveAttribute('aria-sort', 'ascending')

  await page.getByRole('button', { name: 'Show newest update first' }).click()
  await expect(header(page, 'Points')).not.toHaveAttribute('aria-sort')
  await expect(header(page, 'Points').locator('[data-sort-icon]')).toHaveAttribute(
    'data-sort-icon',
    'none',
  )
  await settled(page)
  await expect(page.getByText('More items cannot be loaded in this order.')).toHaveCount(0)
  // In the default order "Load more" works again.
  const rows = itemsTable(page, 'Product')
    .getByRole('row')
    .filter({ has: page.getByRole('cell') })
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(rows).toHaveCount(DEFAULT_PAGE_LIMIT * 2)
})
