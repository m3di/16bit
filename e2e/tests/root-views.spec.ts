import type { Response } from '@playwright/test'
import { expect, test } from './support/fixtures.ts'

// The hub page reads root views from the view routes (D76, D83). `pnpm seed` gives the Parcel
// Tracker hub in `demo` two stored views, Home (which the hub opens on) and My work, both in
// views-only folders, and the Backlog folder no view. Nothing here writes.

const HUB = '/w/demo/hubs/parcel'

const viewData = (r: Response, folder: string) =>
  r.request().method() === 'GET' &&
  new URL(r.url()).pathname.endsWith(`/folders/${folder}/view/data`)

/** Every block in a view-data answer, by status. */
async function statuses(response: Response) {
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { blocks: Record<string, { status: string }> }
  return Object.values(body.blocks).map((b) => b.status)
}

test('the hub opens on its stored Home view, whose blocks are read from real data', async ({
  page,
}) => {
  const data = page.waitForResponse((r) => viewData(r, 'parcel-home'))
  await page.goto(HUB)
  await expect(page.getByRole('heading', { level: 1, name: 'Parcel Tracker v2' })).toBeVisible()
  const blocks = await statuses(await data)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks.every((s) => s === 'ok')).toBe(true)
  await expect(page.locator('[data-block-state="ready"]').first()).toBeVisible()
  await expect(page.locator('[data-block-state="error"]')).toHaveCount(0)
})

test('My work is a stored view too, read for the signed-in person', async ({ page }) => {
  const data = page.waitForResponse((r) => viewData(r, 'parcel-work'))
  await page.goto(`${HUB}/parcel-work`)
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
  await page.route('**/v1/workspaces/demo/folders/parcel-backlog/view', async (route) => {
    await held
    await route.continue()
  })
  const query = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/v1/workspaces/demo/query',
  )
  await page.goto(`${HUB}/parcel-backlog`)
  await query
  answer()
  await expect(page.getByRole('heading', { level: 1, name: 'Backlog' })).toBeVisible()
  await expect(page.locator('[data-virtual] tbody tr[data-index]').first()).toBeVisible()
})
