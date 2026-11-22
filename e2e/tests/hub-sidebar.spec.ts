import {
  attributeSchema,
  folderSchema,
  hubDescriptionSchema,
  hubListEntrySchema,
  type HubDescription,
} from '@16bit/core'
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

test("the demo Product hub shows the root's own 300, not the hub's 1,200", async ({ pageAs }) => {
  // Ivy views Product and never writes there; no spec adds items to the seeded hubs.
  for (const viewport of [undefined, PHONE]) {
    const page = await pageAs('ivy', viewport)
    await page.goto(hubPath('product'))
    const root = folderLink(page, /^Items in Product/)
    await expect(root).toHaveAccessibleName('Items in Product 300 items')
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
    await expect(page.locator('[data-count]')).toHaveText('300 items')
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

// Folder actions in the sidebar (issue 233): the same menu as Hub settings → Folders, for those
// who may change the hub's schema, with the same writes.

async function describeHub(client: Client, hubId: string): Promise<HubDescription> {
  const res = await client.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  return hubDescriptionSchema.parse(await res.json())
}

async function newHub(owner: Client, label: string) {
  const created = await owner.post('/hubs', {
    name: uniqueHubName(label),
    color: 'teal',
    idPrefix: uniquePrefix(),
  })
  await expectStatus(created, 201)
  return hubListEntrySchema.parse(await created.json())
}

function menuButton(page: Page, folder: string) {
  return sidebar(page).getByRole('button', { name: `Actions for ${folder}`, exact: true })
}

async function sidebarMenu(page: Page, folder: string, item: string) {
  await menuButton(page, folder).click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('a hub admin changes folders from the sidebar, as in settings', async ({ page, as }) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'sidebar menu')
  const noteRes = await owner.post(`/hubs/${hub.id}/attributes`, {
    name: 'Note',
    type: 'text',
    config: {},
  })
  await expectStatus(noteRes, 201)
  const note = attributeSchema.parse(await noteRes.json())

  await page.goto(hubPath(hub.id))
  const url = page.url()
  // The root offers what its row in settings offers. Opening a menu never navigates.
  await menuButton(page, hub.name).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Attributes', 'New folder inside'])
  expect(page.url()).toBe(url)
  await page.getByRole('menuitem', { name: 'New folder inside' }).click()
  let dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Name').fill('Planning')
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-sidebar-status]')).toHaveText('Created Planning.')
  // In the sidebar without a reload, and on the server.
  await expect(folderLink(page, /^Planning/)).toBeVisible()
  let d = await describeHub(owner, hub.id)
  const planning = d.folders.find((f) => f.name === 'Planning')
  expect(planning).toMatchObject({ parentId: hub.id })

  // A folder's menu: the four entries of settings.
  await menuButton(page, 'Planning').click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Rename, recolour or move',
    'Attributes',
    'New folder inside',
    'Delete folder',
  ])
  await page.getByRole('menuitem', { name: 'New folder inside' }).click()
  dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Name').fill('Sprint 1')
  await dialog.getByRole('radio', { name: 'Violet' }).check()
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(dialog).toBeHidden()
  await expect(folderLink(page, /^Sprint 1/)).toBeVisible()
  d = await describeHub(owner, hub.id)
  const sprint = d.folders.find((f) => f.name === 'Sprint 1')
  expect(sprint).toMatchObject({ parentId: planning?.id, color: 'violet' })

  // Rename it and move it up to the hub, while it is the open folder.
  await folderLink(page, /^Sprint 1/).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sprint 1')
  await sidebarMenu(page, 'Sprint 1', 'Rename, recolour or move')
  dialog = page.getByRole('dialog', { name: 'Edit Sprint 1' })
  await dialog.getByLabel('Name').fill('Iteration 1')
  await dialog.getByLabel('Inside').selectOption(hub.id)
  await dialog.getByRole('button', { name: 'Save folder' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Iteration 1')
  await expect(folderLink(page, /^Iteration 1/)).toHaveAttribute('aria-current', 'page')
  d = await describeHub(owner, hub.id)
  expect(d.folders.find((f) => f.id === sprint?.id)).toMatchObject({
    name: 'Iteration 1',
    parentId: hub.id,
  })

  // Attributes of Planning: its table gets the column.
  await sidebarMenu(page, 'Planning', 'Attributes')
  dialog = page.getByRole('dialog', { name: 'Attributes in Planning' })
  await dialog.getByLabel('Add an attribute').selectOption({ label: 'Note (Text)' })
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save attributes' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-sidebar-status]')).toHaveText(
    'Saved the attributes of Planning.',
  )
  d = await describeHub(owner, hub.id)
  expect(
    d.folderAttributes.filter((fa) => fa.folderId === planning?.id).map((fa) => fa.attributeId),
  ).toEqual([note.id])
  await folderLink(page, /^Planning/).click()
  await expect(
    page
      .getByRole('table', { name: 'Items in Planning' })
      .getByRole('columnheader', { name: /^Note/ }),
  ).toBeVisible()

  // A folder holding an item cannot be deleted: the entry says why (D52).
  await owner.createItem(planning?.id ?? '', {})
  await expect(folderLink(page, /^Planning/)).toHaveAccessibleName('Planning 1 item')
  await menuButton(page, 'Planning').click()
  const refused = page.getByRole('menuitem', { name: 'Delete folder' })
  await expect(refused).toHaveAttribute('aria-disabled', 'true')
  await expect(refused).toHaveAccessibleDescription('It still holds items.')
  await page.keyboard.press('Escape')
  await expect(menuButton(page, 'Planning')).toBeFocused()

  // An empty one can. It was the open folder, so the hub's own items show instead.
  await folderLink(page, /^Iteration 1/).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Iteration 1')
  await sidebarMenu(page, 'Iteration 1', 'Delete folder')
  const confirm = page.getByRole('dialog', { name: 'Delete Iteration 1?' })
  await confirm.getByRole('button', { name: 'Delete folder' }).click()
  await expect(confirm).toBeHidden()
  await expect(folderLink(page, /^Iteration 1/)).toHaveCount(0)
  await expect(page.locator('[data-sidebar-status]')).toHaveText('Deleted Iteration 1.')
  await expect(page.locator('[data-sidebar-status]')).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`${hubPath(hub.id)}$`))
  d = await describeHub(owner, hub.id)
  expect(d.folders.some((f) => f.id === sprint?.id)).toBe(false)
})

test('the sidebar menu works by keyboard and shows on focus', async ({ page, as }) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'sidebar keys')

  await page.goto(hubPath(hub.id))
  const root = folderLink(page, new RegExp(`^Items in ${hub.name}`))
  const actions = sidebar(page).locator('[data-folder-actions]')
  await expect(actions).toHaveCSS('opacity', '0')
  await root.focus()
  await page.keyboard.press('Tab')
  await expect(menuButton(page, hub.name)).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Attributes' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(menuButton(page, hub.name)).toBeFocused()

  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'New folder inside' })).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'New folder' })
  await expect(dialog.getByLabel('Name')).toBeFocused()
  await page.keyboard.type('Keyed')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(folderLink(page, /^Keyed/)).toBeVisible()
  expect((await describeHub(owner, hub.id)).folders.map((f) => f.name)).toEqual(['Keyed'])
})

test('only those who may change the schema get folder menus', async ({ pageAs }) => {
  // Leo edits Product and Ivy views it: no menus.
  for (const person of ['leo', 'ivy'] as const) {
    const page = await pageAs(person)
    await page.goto(hubPath('product'))
    await expect(folderLink(page, /^Roadmap/)).toBeVisible()
    await expect(sidebar(page).getByRole('button')).toHaveCount(0)
    await page.close()
  }
  // Mina is a workspace admin and hub admin of Support. At phone width the buttons show
  // without hover.
  const mina = await pageAs('mina', PHONE)
  await mina.goto(hubPath('support'))
  await expect(menuButton(mina, 'Support')).toBeVisible()
  await expect(menuButton(mina, 'Inbox')).toBeVisible()
  await expect(sidebar(mina).locator('[data-folder-actions]').first()).toHaveCSS('opacity', '1')
})
