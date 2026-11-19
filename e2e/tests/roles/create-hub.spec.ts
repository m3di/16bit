import { hubDescriptionSchema, hubPageSchema, itemSchema, type HubListEntry } from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  test,
  uniqueHubName,
  uniqueTitle,
  workspaceSection,
  WS,
  WS_NAME,
  type Client,
} from '../support/roles.ts'

// #118: owners and admins create hubs from the dashboard and land in the new hub's General
// settings as its hub admin; "New item" checks the folder's required attributes before it sends
// anything, and opens the new item's page. Outcomes are checked through the API.

const PHONE = { width: 390, height: 844 }

async function hubList(client: Client): Promise<HubListEntry[]> {
  const res = await client.get('/hubs?limit=200')
  await expectStatus(res, 200)
  return hubPageSchema.parse(await res.json()).items
}

/** Deletes a hub a test created; it is empty, so the API allows it (D52). */
async function removeHub(client: Client, hubId: string) {
  const res = await client.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  const { hub } = hubDescriptionSchema.parse(await res.json())
  await expectStatus(await client.delete(`/hubs/${hubId}?version=${String(hub.version)}`), 204)
}

function newHubDialog(page: Page) {
  return page.getByRole('dialog', { name: 'New hub' })
}

for (const person of ['owner', 'mina'] as const) {
  test(`${person === 'owner' ? 'an owner' : 'an admin'} creates a hub from the dashboard and lands in its settings as hub admin`, async ({
    pageAs,
    as,
  }) => {
    const client = as(person)
    const name = uniqueHubName(`ui ${person}`)
    const page = await pageAs(person)
    await page.goto('/')

    await workspaceSection(page)
      .getByRole('button', { name: `New hub in ${WS_NAME}` })
      .click()
    const dialog = newHubDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Name')).toBeFocused()
    await dialog.getByLabel('Name').fill(name)
    // The prefix follows the name ("Zz e2e ui owner ...": initials) until it is typed over.
    await expect(dialog.getByLabel('ID prefix')).toHaveValue(person === 'owner' ? 'ZEUO' : 'ZEUM')
    await dialog.getByLabel('ID prefix').fill('zq1')
    await dialog.getByRole('radio', { name: 'Violet' }).check()
    await dialog.getByRole('button', { name: 'Create hub' }).click()

    await expect(page).toHaveURL(new RegExp(`/w/${WS}/hubs/[^/]+/settings/general$`))
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    const hubId = decodeURIComponent(new URL(page.url()).pathname.split('/')[4] ?? '')

    // Created as asked, with the creator as its hub admin.
    const listed = (await hubList(client)).find((h) => h.id === hubId)
    expect(listed).toMatchObject({
      access: 'granted',
      hubRole: 'hub_admin',
      name,
      color: 'violet',
      idPrefix: 'ZQ1',
    })
    const described = await client.get(`/hubs/${hubId}`)
    await expectStatus(described, 200)
    expect(hubDescriptionSchema.parse(await described.json()).hubRole).toBe('hub_admin')

    // The settings page lets them change it, as hub admin.
    await expect(page.getByLabel('Name', { exact: true })).toBeEditable()

    await removeHub(client, hubId)
  })
}

test('members, viewers and finance are not offered "New hub"', async ({ pageAs }) => {
  for (const person of ['leo', 'ivy', 'noor'] as const) {
    const page = await pageAs(person)
    await page.goto('/')
    await expect(workspaceSection(page).locator('[data-hub-card]').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^New hub/ })).toHaveCount(0)
  }
})

test('a hub without a name or with a bad prefix is not sent', async ({ page, as }) => {
  const name = uniqueHubName('bad prefix')
  const posts: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/v1/workspaces/${WS}/hubs`)) posts.push(r.url())
  })

  await page.goto('/')
  await workspaceSection(page)
    .getByRole('button', { name: `New hub in ${WS_NAME}` })
    .click()
  const dialog = newHubDialog(page)
  await dialog.getByRole('button', { name: 'Create hub' }).click()
  await expect(dialog.getByText('Name the hub.')).toBeVisible()
  await expect(dialog.getByText('Choose an ID prefix.')).toBeVisible()

  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('ID prefix').fill('9AB')
  await dialog.getByRole('button', { name: 'Create hub' }).click()
  await expect(
    dialog.getByText('Start with a letter, then use up to 9 letters or digits.'),
  ).toBeVisible()
  await expect(dialog.getByLabel('ID prefix')).toHaveAttribute('aria-invalid', 'true')

  // Escape closes it, nothing was sent, and no hub was made.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(posts).toEqual([])
  expect((await hubList(as('owner'))).some((h) => h.name === name)).toBe(false)
})

test('a refused create keeps the dialog open and says why', async ({ page, as }) => {
  const name = uniqueHubName('refused')
  await page.route(`**/v1/workspaces/${WS}/hubs`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forbidden', message: 'No' }),
        })
      : route.fallback(),
  )
  await page.goto('/')
  await workspaceSection(page)
    .getByRole('button', { name: `New hub in ${WS_NAME}` })
    .click()
  const dialog = newHubDialog(page)
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create hub' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Your role does not allow creating hubs in this workspace.',
  )
  await expect(dialog.getByLabel('Name')).toHaveValue(name)
  expect((await hubList(as('owner'))).some((h) => h.name === name)).toBe(false)
})

test('the new hub dialog fits a phone screen', async ({ pageAs }) => {
  const page = await pageAs('owner', PHONE)
  await page.goto('/')
  await workspaceSection(page)
    .getByRole('button', { name: `New hub in ${WS_NAME}` })
    .click()
  const dialog = newHubDialog(page)
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width)
  await expect(dialog.getByRole('button', { name: 'Create hub' })).toBeInViewport()
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(PHONE.width)
})

test('"New item" checks required attributes first, then opens the new item’s page', async ({
  pageAs,
  as,
}) => {
  const page = await pageAs('leo')
  const posts: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/v1/workspaces/${WS}/items`)) posts.push(r.url())
  })
  await page.goto(hubPath('launch'))
  await page.getByRole('button', { name: 'New item' }).click()
  const form = page.getByRole('complementary', { name: 'New item', exact: true })

  // Title is required in Launch: nothing is sent without it.
  await form.getByRole('button', { name: 'Create item' }).click()
  await expect(form.getByText('A value is required')).toBeVisible()
  expect(posts).toEqual([])

  const name = uniqueTitle('new item page')
  await form.getByLabel('Title (required)').fill(name)
  await form.getByRole('button', { name: 'Create item' }).click()

  await expect(page).toHaveURL(new RegExp(`/w/${WS}/items/[^/?]+$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  expect(posts).toHaveLength(1)
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '')
  const res = await as('owner').get(`/items/${encodeURIComponent(id)}`)
  await expectStatus(res, 200)
  expect(itemSchema.parse(await res.json())).toMatchObject({
    hubId: 'launch',
    values: { 'launch-title': name },
  })
})
