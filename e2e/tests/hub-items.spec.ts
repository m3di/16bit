import type { Page } from '@playwright/test'
import { demo, expect, test, uniqueTitle } from './support/fixtures.ts'

const title = demo.hub.titleAttributeId
const hubPath = `/w/${demo.workspaceId}/hubs/${demo.hub.id}`

function table(page: Page) {
  return page.getByRole('table', { name: `Items in ${demo.hub.name}` })
}

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Item', exact: true })
}

test('an item created through the API appears in the table', async ({ api, page }) => {
  const name = uniqueTitle('table')
  const item = await api.createItem({ values: { [title]: name } })

  await page.goto(hubPath)
  const row = table(page).getByRole('row').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(
    row.getByRole('link', { name: `DSN-${String(item.seqId)}`, exact: true }),
  ).toBeVisible()
})

test('a hub card on the dashboard opens the hub', async ({ api, page }) => {
  const name = uniqueTitle('from dashboard')
  await api.createItem({ values: { [title]: name } })

  await page.goto('/')
  await page
    .getByRole('region', { name: demo.workspaceName })
    .getByRole('link', { name: new RegExp(`^${demo.hub.name}\\b`) })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: demo.hub.name })).toBeVisible()
  await expect(table(page).getByRole('row').filter({ hasText: name })).toBeVisible()
})

test('an edit in the item panel persists', async ({ api, page }) => {
  const item = await api.createItem({ values: { [title]: uniqueTitle('before edit') } })
  const edited = uniqueTitle('after edit')

  await page.goto(hubPath)
  await table(page)
    .getByRole('link', { name: `DSN-${String(item.seqId)}`, exact: true })
    .click()
  await expect(
    panel(page).getByRole('heading', { name: `DSN-${String(item.seqId)}`, exact: true }),
  ).toBeVisible()

  const field = panel(page).getByLabel('Title (required)')
  await field.fill(edited)
  await field.press('Enter')
  await expect(panel(page).locator('[data-item-version]')).toHaveText('2')
  await expect(table(page).getByRole('row').filter({ hasText: edited })).toBeVisible()

  // Saved on the server, not only on screen.
  const stored = await api.getItem(item.id)
  expect(stored).toMatchObject({ version: 2, values: { [title]: edited } })

  await page.reload()
  await expect(panel(page).getByLabel('Title (required)')).toHaveValue(edited)
  await expect(panel(page).locator('[data-item-version]')).toHaveText('2')
})

test('an edit made against a stale version rolls back and says so', async ({ api, page }) => {
  const item = await api.createItem({ values: { [title]: uniqueTitle('conflict ui') } })
  const theirs = uniqueTitle('their edit')

  await page.goto(`${hubPath}?item=${item.id}`)
  const field = panel(page).getByLabel('Title (required)')
  await expect(field).toHaveValue(item.values[title] as string)

  // Someone else saves first. The open panel still holds version 1.
  await api.parseItem(await api.patchItem(item, { version: 1, values: { [title]: theirs } }))

  await field.fill(uniqueTitle('my edit'))
  await field.press('Enter')

  await expect(page.getByRole('alert')).toContainText('was changed by someone else')
  await expect(field).toHaveValue(theirs)
  await expect(panel(page).locator('[data-item-version]')).toHaveText('2')
  expect((await api.getItem(item.id)).values[title]).toBe(theirs)
})

test('a new row cannot be opened until the server confirms it', async ({ page }) => {
  const name = uniqueTitle('pending')

  // Hold the create request until the test lets it go.
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/v1/workspaces/${demo.workspaceId}/items`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await held
    return route.fallback()
  })

  await page.goto(hubPath)
  await page.getByRole('button', { name: 'New item' }).click()
  const form = page.getByRole('complementary', { name: 'New item', exact: true })
  await form.getByLabel('Title (required)').fill(name)
  await form.getByRole('button', { name: 'Create item' }).click()

  const row = table(page).getByRole('row').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Saving…')
  await expect(row.getByRole('link')).toHaveCount(0)

  // Clicking the unconfirmed row does nothing: no panel for it, the URL does not change.
  await row.getByText(name).click()
  await expect(page).not.toHaveURL(/[?&]item=/)
  await expect(panel(page)).toHaveCount(0)

  release()
  await expect(row.getByRole('link', { name: /^DSN-\d+$/ })).toBeVisible()
  await expect(page).toHaveURL(/[?&]item=/)
  await expect(panel(page).getByLabel('Title (required)')).toHaveValue(name)
  await expect(panel(page).getByLabel('Title (required)')).toBeEnabled()
})

test('?item= for an item from another hub shows that it does not exist', async ({ api, page }) => {
  const other = await api.createItem({
    folderId: 'hiring',
    values: { 'hiring-title': uniqueTitle('other hub') },
  })

  await page.goto(`${hubPath}?item=${other.id}`)
  await expect(panel(page).getByText('This item does not exist')).toBeVisible()
  await expect(panel(page).getByLabel('Title (required)')).toHaveCount(0)
})

test('?item= for an unknown item shows that it does not exist', async ({ page }) => {
  await page.goto(`${hubPath}?item=e2e-no-such-item`)
  await expect(panel(page).getByText('This item does not exist')).toBeVisible()
})
