import type { Page } from '@playwright/test'
import { OWNER_STATE } from './support/auth-state.ts'
import { demo, expect, test, uniqueTitle } from './support/fixtures.ts'

// Live sync (D57 to D60, issue 175): two browser contexts on the same folder. An edit in one
// shows up in the other over the feed, without a reload.

const title = demo.hub.titleAttributeId
const hubPath = `/w/${demo.workspaceId}/hubs/${demo.hub.id}`

const table = (page: Page) => page.getByRole('table', { name: `Items in ${demo.hub.name}` })
const panel = (page: Page) => page.getByRole('complementary', { name: 'Item', exact: true })

test('an edit in one browser shows up in another without a reload', async ({ api, browser }) => {
  const before = uniqueTitle('live before')
  const after = uniqueTitle('live after')
  const item = await api.createItem({ values: { [title]: before } })

  const writer = await browser.newContext({ storageState: OWNER_STATE })
  const reader = await browser.newContext({ storageState: OWNER_STATE })
  try {
    const a = await writer.newPage()
    const b = await reader.newPage()
    // The reader's feed socket, to know it is live before the edit is made.
    const subscribed = b.waitForEvent('websocket', (ws) => ws.url().endsWith('/feed'))
    await b.goto(hubPath)
    await expect(table(b).getByRole('row').filter({ hasText: before })).toBeVisible()
    const socket = await subscribed
    await socket.waitForEvent('framereceived', (frame) =>
      String(frame.payload).includes('"type":"changes"'),
    )
    let reloaded = false
    b.on('framenavigated', () => {
      reloaded = true
    })

    await a.goto(`${hubPath}?item=${item.id}`)
    const field = panel(a).getByLabel('Title (required)')
    await expect(field).toHaveValue(before)
    await field.fill(after)
    await field.press('Enter')
    await expect(panel(a).locator('[data-item-version]')).toHaveText('2')

    await expect(table(b).getByRole('row').filter({ hasText: after })).toBeVisible()
    await expect(table(b).getByRole('row').filter({ hasText: before })).toHaveCount(0)
    expect(reloaded).toBe(false)
    await expect(b.locator('[data-connection]')).not.toContainText('Offline')
  } finally {
    await writer.close()
    await reader.close()
  }
})

test('a draft being typed is kept when someone else saves, and the conflict offers both', async ({
  api,
  browser,
}) => {
  const item = await api.createItem({ values: { [title]: uniqueTitle('draft before') } })
  const theirs = uniqueTitle('draft theirs')
  const mine = uniqueTitle('draft mine')

  const typist = await browser.newContext({ storageState: OWNER_STATE })
  const other = await browser.newContext({ storageState: OWNER_STATE })
  try {
    const a = await typist.newPage()
    const b = await other.newPage()
    // The typist's feed is live before anything is saved.
    const subscribed = a.waitForEvent('websocket', (ws) => ws.url().endsWith('/feed'))
    await a.goto(`${hubPath}?item=${item.id}`)
    const socket = await subscribed
    await socket.waitForEvent('framereceived', (frame) =>
      String(frame.payload).includes('"type":"changes"'),
    )
    const field = panel(a).getByLabel('Title (required)')
    await expect(field).toHaveValue(item.values[title] as string)
    await field.fill(mine)

    // Someone else saves the same field.
    await b.goto(`${hubPath}?item=${item.id}`)
    const theirField = panel(b).getByLabel('Title (required)')
    await theirField.fill(theirs)
    await theirField.press('Enter')
    await expect(panel(b).locator('[data-item-version]')).toHaveText('2')

    // The typist keeps the draft and is told, with the new value.
    const note = panel(a).locator('[data-changed-while-editing]')
    await expect(note.getByRole('status')).toContainText(
      `Changed by Dev Owner while you were editing: “${theirs}”`,
    )
    await expect(field).toHaveValue(mine)

    // Saving meets the conflict: theirs is shown, and the draft is offered back.
    await field.press('Enter')
    const offer = panel(a).locator('[data-refused-draft]')
    await expect(offer).toContainText(`“${mine}” was not saved`)
    await expect(field).toHaveValue(theirs)
    expect((await api.getItem(item.id)).values[title]).toBe(theirs)

    await offer.getByRole('button', { name: 'Keep mine' }).click()
    await expect(panel(a).locator('[data-item-version]')).toHaveText('3')
    await expect(field).toHaveValue(mine)
    await expect(offer).toHaveCount(0)
    expect(await api.getItem(item.id)).toMatchObject({ version: 3, values: { [title]: mine } })
  } finally {
    await typist.close()
    await other.close()
  }
})

test('a live create puts the item first and keeps focus on the row the reader left (D61)', async ({
  api,
  browser,
}) => {
  // Product's own items (about 300) are enough to scroll a row far out of view, so this test
  // adds only its one item, and does not crowd the Design hub the other specs here watch.
  const productPath = `/w/${demo.workspaceId}/hubs/product`
  const products = (page: Page) => page.getByRole('table', { name: 'Items in Product' })
  const reader = await browser.newContext({ storageState: OWNER_STATE })
  try {
    const page = await reader.newPage()
    const rowCount = async () =>
      Number((await products(page).getAttribute('aria-rowcount')) ?? '1') - 1
    const subscribed = page.waitForEvent('websocket', (ws) => ws.url().endsWith('/feed'))
    await page.goto(productPath)
    await expect(products(page).locator('tbody tr[data-row]').first()).toBeVisible()
    const socket = await subscribed
    await socket.waitForEvent('framereceived', (frame) =>
      String(frame.payload).includes('"type":"changes"'),
    )

    // The reader moves to the second row by keyboard, then scrolls it far out of view.
    await products(page).locator('tbody tr[data-index="0"]').focus()
    await page.keyboard.press('ArrowDown')
    const second = products(page).locator('tbody tr[data-index="1"]')
    await expect(second).toBeFocused()
    const id = await second.getByRole('link').innerText()
    await page.locator('[data-virtual]').evaluate((el) => {
      el.scrollTop = 100 * 38
    })
    const before = await rowCount()

    // Someone else creates an item: it goes first, and every row moves down one. Other specs
    // may add to Product meanwhile, so the row is found by its ID, not by a fixed index.
    const fresh = uniqueTitle('live create')
    await api.createItem({ folderId: 'product', values: { 'product-title': fresh } })
    await expect.poll(rowCount).toBeGreaterThan(before)
    const focused = products(page).locator('tbody tr:focus')
    await expect(focused.getByRole('link')).toHaveText(id)
    expect(Number(await focused.getAttribute('data-index'))).toBeGreaterThan(1)

    await page.locator('[data-virtual]').evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(products(page).getByRole('row').filter({ hasText: fresh })).toBeVisible()
  } finally {
    await reader.close()
  }
})
