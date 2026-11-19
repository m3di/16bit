import {
  agentKeyPageSchema,
  attributeSchema,
  folderSchema,
  hubDescriptionSchema,
  hubGrantPageSchema,
  hubListEntrySchema,
  type HubDescription,
  type HubGrantEntry,
} from '@16bit/core'
import type { Page } from '@playwright/test'
import { people } from './support/auth-state.ts'
import { expect, expectStatus, test, uniqueHubName, WS, type Client } from './support/roles.ts'

// Hub settings, general, access, agent keys and danger zone (#116). Every test works in a hub it
// creates, so the seeded hubs never change; each outcome is checked through the API.

const PHONE = { width: 390, height: 844 }

async function newHub(owner: Client, label: string) {
  const res = await owner.post('/hubs', {
    name: uniqueHubName(label),
    color: 'teal',
    idPrefix: 'ACC',
  })
  await expectStatus(res, 201)
  return hubListEntrySchema.parse(await res.json())
}

async function describeHub(client: Client, hubId: string): Promise<HubDescription> {
  const res = await client.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  return hubDescriptionSchema.parse(await res.json())
}

async function grantsOf(client: Client, hubId: string): Promise<HubGrantEntry[]> {
  const res = await client.get(`/hubs/${hubId}/grants?limit=200`)
  await expectStatus(res, 200)
  return hubGrantPageSchema.parse(await res.json()).items
}

const settings = (hubId: string, section: string) => `/w/${WS}/hubs/${hubId}/settings/${section}`

async function menu(page: Page, row: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${row}`, exact: true }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('a hub admin renames and recolours the hub and sets its title attribute (D50)', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'general')
  const created = await owner.post(`/hubs/${hub.id}/attributes`, {
    name: 'Summary',
    type: 'text',
    indexed: false,
    config: {},
  })
  await expectStatus(created, 201)
  const summary = attributeSchema.parse(await created.json())
  // One item in the hub and one in a folder: the total counts both.
  const folder = folderSchema.parse(
    await (
      await owner.post(`/hubs/${hub.id}/folders`, {
        parentId: hub.id,
        name: 'Inbox',
        color: 'blue',
      })
    ).json(),
  )
  await owner.createItem(hub.id, {})
  await owner.createItem(folder.id, {})

  await page.goto(settings(hub.id, 'general'))
  const general = page.getByRole('region', { name: 'General' })
  await expect(general.getByText('2 items in this hub, counting every folder.')).toBeVisible()

  const renamed = `${hub.name} renamed`
  await general.getByLabel('Name').fill(renamed)
  await general.getByLabel('Name').press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible()
  await expect.poll(async () => (await describeHub(owner, hub.id)).hub.name).toBe(renamed)

  await general.getByRole('radio', { name: 'Violet' }).check()
  await expect.poll(async () => (await describeHub(owner, hub.id)).hub.color).toBe('violet')

  await general.getByLabel('Item title').selectOption(summary.id)
  await expect
    .poll(async () => (await describeHub(owner, hub.id)).hub.titleAttributeId)
    .toBe(summary.id)
  await expect(general.getByText('All changes saved')).toBeVisible()

  // A reload shows what the server holds.
  await page.reload()
  await expect(page.getByRole('region', { name: 'General' }).getByLabel('Item title')).toHaveValue(
    summary.id,
  )
})

test('an editor sees general settings read-only and cannot see access or keys', async ({
  pageAs,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'editor')
  await expectStatus(
    await owner.put(`/hubs/${hub.id}/grants/${people.leo.id}`, { hubRole: 'editor' }),
    200,
  )
  const page = await pageAs('leo')
  await page.goto(settings(hub.id, 'general'))
  await expect(page.getByText('Only hub admins can rename this hub')).toBeVisible()
  await expect(page.getByLabel('Name')).toHaveCount(0)
  await page.getByRole('link', { name: 'Access' }).click()
  await expect(page.getByText('You cannot see who has access')).toBeVisible()
  await page.getByRole('link', { name: 'Agent keys' }).click()
  await expect(page.getByText('You cannot see this hub’s agent keys')).toBeVisible()
  // The API agrees.
  await expectStatus(await as('leo').get(`/hubs/${hub.id}/grants`), 403)
})

test('a hub admin adds someone, changes their role and revokes it', async ({
  page,
  as,
  invite,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'access')
  const person = await invite('member')

  await page.goto(settings(hub.id, 'access'))
  const access = page.getByRole('region', { name: 'Access' })
  await expect(access.getByRole('rowheader', { name: /Dev Owner/ })).toBeVisible()

  await access.getByRole('button', { name: 'Add people' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add people' })
  await dialog.getByLabel('Person').selectOption(person.principalId)
  await dialog.getByLabel('Hub role').selectOption('editor')
  await dialog.getByRole('button', { name: 'Add to hub' }).click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(
      async () =>
        (await grantsOf(owner, hub.id)).find((g) => g.principalId === person.principalId)?.hubRole,
    )
    .toBe('editor')

  await access.getByLabel(`Hub role for ${person.name}`).selectOption('viewer')
  await access.getByLabel(`Hub role for ${person.name}`).blur()
  await expect
    .poll(
      async () =>
        (await grantsOf(owner, hub.id)).find((g) => g.principalId === person.principalId)?.hubRole,
    )
    .toBe('viewer')

  await menu(page, person.name, 'Revoke access')
  await expect(access.getByRole('rowheader', { name: person.name })).toHaveCount(0)
  await expect(
    page.getByRole('status').filter({ hasText: `Revoked ${person.name}'s access.` }),
  ).toBeFocused()
  await expect
    .poll(async () =>
      (await grantsOf(owner, hub.id)).some((g) => g.principalId === person.principalId),
    )
    .toBe(false)
  // They lost the hub: it is a 404 to them now.
  await expectStatus(await person.client.get(`/hubs/${hub.id}`), 404)
})

test('the access table works at phone width', async ({ pageAs, as }) => {
  const hub = await newHub(as('owner'), 'phone')
  const page = await pageAs('owner', PHONE)
  await page.goto(settings(hub.id, 'access'))
  await expect(page.getByRole('navigation', { name: 'Hub settings' })).toBeVisible()
  const access = page.getByRole('region', { name: 'Access' })
  await expect(access.getByRole('rowheader', { name: /Dev Owner/ })).toBeVisible()
  await expect(access.getByRole('button', { name: 'Add people' })).toBeVisible()
  // The page itself never scrolls sideways; the table scrolls in its own box.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('a hub admin creates an agent key, sees its secret once, and revokes it', async ({
  page,
  as,
  bearer,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'keys')
  await page.goto(settings(hub.id, 'agent-keys'))
  await expect(page.getByText('No agent keys yet')).toBeVisible()

  await page.getByRole('button', { name: 'New agent key' }).click()
  let dialog = page.getByRole('dialog', { name: 'New agent key' })
  await dialog.getByLabel('Name').fill('e2e-agent')
  await dialog.getByLabel('Hub role').selectOption('commenter')
  await dialog.getByLabel('Expires').selectOption('never')
  await dialog.getByRole('button', { name: 'Create key' }).click()
  dialog = page.getByRole('dialog', { name: 'Agent key secret' })
  const secret = await dialog.getByLabel('Secret').inputValue()
  expect(secret).toMatch(/^16b_/)
  // Escape does not close it: the secret cannot be shown again.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()

  // The key works in this hub, with the chosen role.
  const agent = await bearer(secret)
  await expectStatus(await agent.get(`/hubs/${hub.id}`), 200)
  const keys = agentKeyPageSchema.parse(
    await (await owner.get(`/hubs/${hub.id}/agent-keys`)).json(),
  )
  expect(keys.items[0]).toMatchObject({ name: 'e2e-agent', hubRole: 'commenter', expiresAt: null })
  // Its grant shows under access, locked to the key.
  await page.getByRole('link', { name: 'Access' }).click()
  await expect(
    page.getByRole('region', { name: 'Access' }).getByText('Set by its key'),
  ).toBeVisible()

  await page.getByRole('link', { name: 'Agent keys' }).click()
  await page.getByRole('button', { name: 'Revoke e2e-agent' }).click()
  const confirm = page.getByRole('dialog', { name: 'Revoke e2e-agent?' })
  await confirm.getByRole('button', { name: 'Revoke key' }).click()
  await expect(confirm).toBeHidden()
  await expect(page.locator('[data-key-row]').getByText('Revoked')).toBeVisible()
  await expectStatus(await agent.get(`/hubs/${hub.id}`), 401)
})

test('an owner deletes an empty hub after typing its name (D52)', async ({ page, as }) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'delete')
  const item = await owner.createItem(hub.id, {})

  await page.goto(settings(hub.id, 'danger'))
  await expect(page.getByText('It still holds 1 item. Delete or move them first.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete hub' })).toBeDisabled()

  await expectStatus(await owner.delete(`/items/${item.id}?version=${String(item.version)}`), 204)
  await page.reload()
  await page.getByRole('button', { name: 'Delete hub' }).click()
  const confirm = page.getByRole('dialog', { name: `Delete ${hub.name}?` })
  await expect(confirm.getByRole('button', { name: 'Delete hub' })).toBeDisabled()
  await confirm.getByRole('textbox').fill(hub.name)
  await confirm.getByRole('button', { name: 'Delete hub' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expectStatus(await owner.get(`/hubs/${hub.id}`), 404)
})

test('an admin cannot delete a hub an owner holds a grant on (D52, footnote 1)', async ({
  pageAs,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'admin delete')
  await expectStatus(
    await owner.put(`/hubs/${hub.id}/grants/${people.mina.id}`, { hubRole: 'hub_admin' }),
    200,
  )
  const page = await pageAs('mina')
  await page.goto(settings(hub.id, 'danger'))
  await expect(
    page.getByText('A workspace owner has access to this hub, so only an owner can delete it.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete hub' })).toBeDisabled()
  const d = await describeHub(owner, hub.id)
  await expectStatus(
    await as('mina').delete(`/hubs/${hub.id}?version=${String(d.hub.version)}`),
    403,
  )
})

test('an owner gives themselves access from the dashboard’s "no access" card', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner, 'self grant')
  await expectStatus(await owner.delete(`/hubs/${hub.id}/grants/${people.owner.id}`), 204)

  await page.goto('/')
  const card = page.locator('[data-hub-card]').filter({ hasText: hub.name })
  await expect(card).toContainText('No access')
  await page.getByRole('button', { name: `Give myself access to ${hub.name}` }).click()
  // The card becomes a link into the hub.
  await expect(page.getByRole('link', { name: new RegExp(hub.name) })).toBeVisible()
  const mine = (await grantsOf(owner, hub.id)).find((g) => g.principalId === people.owner.id)
  expect(mine?.hubRole).toBe('hub_admin')
})
