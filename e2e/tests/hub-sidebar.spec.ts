import { folderSchema, hubDescriptionSchema, hubListEntrySchema } from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  test,
  uniqueHubName,
  uniquePrefix,
  type Client,
} from './support/roles.ts'

// The folder sidebar on a hub's page (issue 231). The hub's root folder reads as the hub's own
// items and shows its own count: the hub's total less its folders'. Its folders are nested
// under it, and every count follows creates and deletes live.

const PHONE = { width: 390, height: 844 }

function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Folders' })
}

function folderLink(page: Page, name: string | RegExp) {
  return sidebar(page).getByRole('link', { name })
}

/** Product's own items as the API counts them: its total less its folders'. */
async function productOwnCount(client: Client): Promise<number> {
  const res = await client.get('/hubs/product')
  await expectStatus(res, 200)
  const d = hubDescriptionSchema.parse(await res.json())
  return d.hub.itemCount - d.folders.reduce((sum, f) => sum + f.itemCount, 0)
}

test("the demo Product hub shows the root's own count, not the hub's total", async ({
  pageAs,
  as,
}) => {
  // Seeded with 300 in the root and 300 in each folder. Other specs add items to the root as
  // they run (an agent key's, a live update's), never to the folders, so the root is checked
  // against the API's count, which is 300 on a fresh seed.
  const ivy = as('ivy')
  expect(await productOwnCount(ivy)).toBeGreaterThanOrEqual(300)
  for (const viewport of [undefined, PHONE]) {
    const page = await pageAs('ivy', viewport)
    await page.goto(hubPath('product'))
    const root = folderLink(page, /^Items in Product/)
    await expect(async () => {
      const own = new Intl.NumberFormat('en').format(await productOwnCount(ivy))
      await expect(root).toHaveAccessibleName(`Items in Product ${own} items`, { timeout: 1000 })
      await expect(page.locator('[data-count]')).toHaveText(`${own} items`, { timeout: 1000 })
    }).toPass()
    await expect(root).toHaveAttribute('aria-current', 'page')
    for (const name of ['Roadmap', 'Bugs', 'Triage']) {
      await expect(folderLink(page, new RegExp(`^${name}\\b`))).toHaveAccessibleName(
        `${name} 300 items`,
      )
    }
    // The folders are nested inside the root's entry, so they read as the hub's.
    const rootEntry = sidebar(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: /^Items in Product/ }) })
      .first()
    await expect(rootEntry.getByRole('list').getByRole('link')).toHaveCount(3)
    await page.close()
  }
})

test("a create or delete in the root moves only the root's count, live", async ({
  as,
  invite,
  pageWithSession,
}) => {
  const owner = as('owner')
  const created = await owner.post('/hubs', {
    name: uniqueHubName('sidebar'),
    color: 'teal',
    idPrefix: uniquePrefix(),
  })
  await expectStatus(created, 201)
  const hub = hubListEntrySchema.parse(await created.json())
  const folderRes = await owner.post(`/hubs/${hub.id}/folders`, {
    parentId: hub.id,
    name: 'Backlog',
    color: 'blue',
  })
  await expectStatus(folderRes, 201)
  const backlog = folderSchema.parse(await folderRes.json())
  await owner.createItem(hub.id, {})
  await owner.createItem(backlog.id, {})
  await owner.createItem(backlog.id, {})

  // An invited viewer, on their own session: the feed allows a few sockets per session and the
  // rest of the suite shares the owner's.
  const viewer = await invite('member')
  await expectStatus(
    await owner.put(`/hubs/${hub.id}/grants/${viewer.principalId}`, { hubRole: 'viewer' }),
    200,
  )
  const page = await pageWithSession(viewer.sid)
  await page.goto(hubPath(hub.id))
  const root = folderLink(page, new RegExp(`^Items in ${hub.name}`))
  const folder = folderLink(page, /^Backlog/)
  await expect(root).toHaveAccessibleName(`Items in ${hub.name} 1 item`)
  await expect(folder).toHaveAccessibleName('Backlog 2 items')

  const item = await owner.createItem(hub.id, {})
  await expect(root).toHaveAccessibleName(`Items in ${hub.name} 2 items`)
  await expect(page.locator('[data-count]')).toHaveText('2 items')
  await expect(folder).toHaveAccessibleName('Backlog 2 items')

  await expectStatus(await owner.delete(`/items/${item.id}?version=${String(item.version)}`), 204)
  await expect(root).toHaveAccessibleName(`Items in ${hub.name} 1 item`)
  await expect(folder).toHaveAccessibleName('Backlog 2 items')

  // A create in the folder moves the folder's count and leaves the root's.
  await owner.createItem(backlog.id, {})
  await expect(folder).toHaveAccessibleName('Backlog 3 items')
  await expect(root).toHaveAccessibleName(`Items in ${hub.name} 1 item`)
})
