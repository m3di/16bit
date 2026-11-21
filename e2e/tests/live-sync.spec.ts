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
