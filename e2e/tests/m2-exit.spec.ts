import {
  hubDescriptionSchema,
  hubGrantPageSchema,
  hubListEntrySchema,
  itemSchema,
  memberPageSchema,
  type HubDescription,
  type Item,
} from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  itemsTable,
  itemPanel,
  test,
  uniqueHubName,
  uniqueTitle,
  workspaceSection,
  WS,
  WS_NAME,
  type Client,
} from './support/roles.ts'

// The M2 exit check (#121, docs/ROADMAP.md): a new hub is created, given attributes and folders,
// and populated, entirely from the UI, as a person would. Every outcome is checked through the
// API. The second test invites someone through the UI, has them join with the link, grants them
// a hub, and shows that a hub editor is kept out of the hub's settings.
//
// What the per-feature specs already cover is not repeated here: create-hub (dialog validation),
// hub-settings (rename, move, conflicts, D51 counts), hub-settings-access (roles, keys, danger
// zone), workspace-members (invite dialog details) and item-page (links, delete).

async function describeHub(client: Client, hubId: string): Promise<HubDescription> {
  const res = await client.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  return hubDescriptionSchema.parse(await res.json())
}

async function getItem(client: Client, id: string): Promise<Item> {
  const res = await client.get(`/items/${encodeURIComponent(id)}`)
  await expectStatus(res, 200)
  return itemSchema.parse(await res.json())
}

const itemIdFromUrl = (page: Page) =>
  decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '')

/** Opens a row's action menu in a settings table and picks an entry. */
async function menu(page: Page, row: string, entry: string) {
  await page.getByRole('button', { name: `Actions for ${row}`, exact: true }).click()
  await page.getByRole('menuitem', { name: entry }).click()
}

function settingsNav(page: Page, section: string) {
  return page
    .getByRole('navigation', { name: 'Hub settings' })
    .getByRole('link', { name: section, exact: true })
}

/** Creates an attribute through the New attribute dialog. */
async function newAttribute(
  page: Page,
  name: string,
  type: string,
  fill?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>,
) {
  await page.getByRole('button', { name: 'New attribute' }).click()
  const dialog = page.getByRole('dialog', { name: 'New attribute' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('radio', { name: type, exact: true }).check()
  if (fill) await fill(dialog)
  await dialog.getByRole('button', { name: 'Create attribute' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-attribute-row]').filter({ hasText: name })).toBeVisible()
}

/** Shows attributes in a folder (or the hub) through its Attributes dialog, then saves. */
async function attachAttributes(
  page: Page,
  folderName: string,
  attributes: { label: string; name: string; required?: boolean }[],
) {
  await menu(page, folderName, 'Attributes')
  const dialog = page.getByRole('dialog', { name: `Attributes in ${folderName}` })
  for (const { label } of attributes) {
    await dialog.getByLabel('Add an attribute').selectOption({ label })
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  }
  for (const { name, required } of attributes) {
    if (required) await dialog.getByRole('switch', { name: `${name} is required` }).click()
  }
  await dialog.getByRole('button', { name: 'Save attributes' }).click()
  await expect(dialog).toBeHidden()
}

test('M2 exit: a new hub is created, given attributes and folders, and populated from the UI', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hubName = uniqueHubName('exit check')

  // 1. Signed in as the owner (auth.setup.ts signs in through the form), create the hub from
  //    the dashboard. It opens on its General settings.
  await page.goto('/')
  await workspaceSection(page)
    .getByRole('button', { name: `New hub in ${WS_NAME}` })
    .click()
  const newHub = page.getByRole('dialog', { name: 'New hub' })
  await newHub.getByLabel('Name').fill(hubName)
  await newHub.getByLabel('ID prefix').fill('EXIT')
  await newHub.getByRole('radio', { name: 'Teal' }).check()
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/v1/workspaces/${WS}/hubs`),
  )
  await newHub.getByRole('button', { name: 'Create hub' }).click()
  const hubId = hubListEntrySchema.parse(await (await created).json()).id
  await expect(page).toHaveURL(new RegExp(`/hubs/${encodeURIComponent(hubId)}/settings/general$`))
  await expect(page.getByRole('heading', { level: 1, name: hubName })).toBeVisible()
  expect((await describeHub(owner, hubId)).hub).toMatchObject({
    name: hubName,
    idPrefix: 'EXIT',
    color: 'teal',
  })

  // 2. Attributes of several types.
  await settingsNav(page, 'Attributes').click()
  await expect(page.getByText('No attributes yet')).toBeVisible()
  await newAttribute(page, 'Title', 'Text')
  await newAttribute(page, 'Points', 'Number')
  await newAttribute(page, 'Stage', 'Select', async (dialog) => {
    await dialog.getByRole('button', { name: 'Add option' }).click()
    await dialog.getByLabel('Name of option 1').fill('To do')
    await dialog.getByRole('button', { name: 'Add option' }).click()
    await dialog.getByLabel('Name of option 2').fill('Done')
  })
  await newAttribute(page, 'Due', 'Date')
  await newAttribute(page, 'Urgent', 'Checkbox')

  let d = await describeHub(owner, hubId)
  const attr = Object.fromEntries(d.attributes.map((a) => [a.name, a]))
  expect(Object.fromEntries(d.attributes.map((a) => [a.name, a.type]))).toEqual({
    Title: 'text',
    Points: 'number',
    Stage: 'select',
    Due: 'date',
    Urgent: 'boolean',
  })
  const stage = attr['Stage']
  if (stage?.type !== 'select') throw new Error('Stage is not a select')
  expect(stage.config.options.map((o) => o.label)).toEqual(['To do', 'Done'])
  const optionId = (label: string) => stage.config.options.find((o) => o.label === label)?.id
  const [title, points, due, urgent] = ['Title', 'Points', 'Due', 'Urgent'].map(
    (n) => attr[n]?.id ?? '',
  ) as [string, string, string, string]

  // 3. Nested folders: Sprint 1 inside Planning.
  await settingsNav(page, 'Folders').click()
  await page.getByRole('button', { name: 'New folder' }).click()
  let folderDialog = page.getByRole('dialog', { name: 'New folder' })
  await folderDialog.getByLabel('Name').fill('Planning')
  await folderDialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(folderDialog).toBeHidden()
  await menu(page, 'Planning', 'New folder inside')
  folderDialog = page.getByRole('dialog', { name: 'New folder' })
  await folderDialog.getByLabel('Name').fill('Sprint 1')
  await folderDialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(folderDialog).toBeHidden()

  d = await describeHub(owner, hubId)
  const planning = d.folders.find((f) => f.name === 'Planning')
  const sprint = d.folders.find((f) => f.name === 'Sprint 1')
  expect(planning?.parentId).toBe(hubId)
  expect(sprint?.parentId).toBe(planning?.id)
  const sprintId = sprint?.id ?? ''

  // The hub shows every attribute, Title required; Sprint 1 shows Title (required) and Stage.
  await attachAttributes(page, hubName, [
    { label: 'Title (Text)', name: 'Title', required: true },
    { label: 'Points (Number)', name: 'Points' },
    { label: 'Stage (Select)', name: 'Stage' },
    { label: 'Due (Date)', name: 'Due' },
    { label: 'Urgent (Checkbox)', name: 'Urgent' },
  ])
  await attachAttributes(page, 'Sprint 1', [
    { label: 'Title (Text)', name: 'Title', required: true },
    { label: 'Stage (Select)', name: 'Stage' },
  ])
  const shown = (folderId: string, fas: HubDescription['folderAttributes']) =>
    fas
      .filter((fa) => fa.folderId === folderId)
      .sort((a, b) => a.position - b.position)
      .map((fa) => [fa.attributeId, fa.required])
  d = await describeHub(owner, hubId)
  expect(shown(hubId, d.folderAttributes)).toEqual([
    [title, true],
    [points, false],
    [stage.id, false],
    [due, false],
    [urgent, false],
  ])
  expect(shown(sprintId, d.folderAttributes)).toEqual([
    [title, true],
    [stage.id, false],
  ])

  // 4. The title attribute.
  await settingsNav(page, 'General').click()
  const general = page.getByRole('region', { name: 'General' })
  await general.getByLabel('Item title').selectOption({ label: 'Title' })
  await expect(general.getByText('All changes saved')).toBeVisible()
  await expect.poll(async () => (await describeHub(owner, hubId)).hub.titleAttributeId).toBe(title)

  // 5. Populate it: an item in the hub, every field filled in.
  await page.getByRole('link', { name: `Back to ${hubName}` }).click()
  await expect(page).toHaveURL(new RegExp(`${hubPath(hubId)}$`))
  await page.getByRole('button', { name: 'New item' }).first().click()
  let form = page.getByRole('complementary', { name: 'New item', exact: true })
  const first = uniqueTitle('exit first')
  await form.getByLabel('Title (required)').fill(first)
  // Points stays empty: Number values cannot be set from the UI yet (#155, the test below).
  await form.getByLabel('Stage').selectOption({ label: 'To do' })
  await form.getByLabel('Due').fill('2026-12-01')
  await form.getByLabel('Urgent').check()
  await form.getByRole('button', { name: 'Create item' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${WS}/items/[^/?]+$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(first)
  const firstId = itemIdFromUrl(page)
  expect(await getItem(owner, firstId)).toMatchObject({
    hubId,
    folderId: hubId,
    version: 1,
    values: {
      [title]: first,
      [stage.id]: optionId('To do'),
      [due]: '2026-12-01',
      [urgent]: true,
    },
  })

  // And one in the nested folder, opened from the sidebar.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: hubName })
    .click()
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('link', { name: /^Sprint 1/ })
    .click()
  await expect(page).toHaveURL(new RegExp(`${hubPath(hubId)}/${encodeURIComponent(sprintId)}$`))
  await page.getByRole('button', { name: 'New item' }).first().click()
  form = page.getByRole('complementary', { name: 'New item', exact: true })
  // Only Sprint 1's own attributes are asked for.
  await expect(form.getByLabel('Points')).toHaveCount(0)
  const second = uniqueTitle('exit second')
  await form.getByLabel('Title (required)').fill(second)
  await form.getByLabel('Stage').selectOption({ label: 'Done' })
  await form.getByRole('button', { name: 'Create item' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(second)
  expect(await getItem(owner, itemIdFromUrl(page))).toMatchObject({
    hubId,
    folderId: sprintId,
    values: { [title]: second, [stage.id]: optionId('Done') },
  })

  // 6. Open the first item from the hub's table on its own page, and edit it there.
  await page.goto(hubPath(hubId))
  await itemsTable(page, hubName).getByRole('row').filter({ hasText: first }).click()
  await itemPanel(page).getByRole('link', { name: 'Open page' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${WS}/items/${encodeURIComponent(firstId)}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(first)

  const renamed = uniqueTitle('exit renamed')
  const titleField = page.getByLabel('Title (required)')
  await titleField.fill(renamed)
  await titleField.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed)
  await expect.poll(async () => (await getItem(owner, firstId)).values[title]).toBe(renamed)
  await page.getByLabel('Stage').selectOption({ label: 'Done' })
  await expect
    .poll(async () => (await getItem(owner, firstId)).values[stage.id])
    .toBe(optionId('Done'))
  await page.getByLabel('Urgent').uncheck()
  await expect.poll(async () => (await getItem(owner, firstId)).values[urgent]).toBe(false)
  // Three edits, three versions, nothing else touched.
  const edited = await getItem(owner, firstId)
  expect(edited).toMatchObject({ version: 4, values: { [due]: '2026-12-01' } })
  expect(edited.values[points] ?? null).toBe(null)
  // The page shows what the server holds after a reload.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed)
  await expect(page.getByLabel('Stage')).toHaveValue(optionId('Done') ?? '')
  await expect(page.getByLabel('Urgent')).not.toBeChecked()

  // 7. A folder that is not empty cannot be deleted: Planning holds Sprint 1, which holds an
  //    item. The menu says why, and the server refuses too (D52).
  await page.goto(`/w/${WS}/hubs/${hubId}/settings/folders`)
  for (const [name, reason] of [
    ['Planning', 'It still holds folders.'],
    ['Sprint 1', 'It still holds items.'],
  ] as const) {
    await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
    const del = page.getByRole('menuitem', { name: 'Delete folder' })
    await expect(del).toHaveAttribute('aria-disabled', 'true')
    await expect(del).toHaveAccessibleDescription(reason)
    await page.keyboard.press('Escape')
    await expect(del).toBeHidden()
  }
  d = await describeHub(owner, hubId)
  for (const folder of d.folders) {
    const res = await owner.delete(`/folders/${folder.id}?version=${String(folder.version)}`)
    await expectStatus(res, 409)
    expect(((await res.json()) as { error: string }).error).toBe('not_empty')
  }
  expect((await describeHub(owner, hubId)).folders).toHaveLength(2)
})

test('an invited person joins with the link, is granted a hub, and as its editor is kept out of its settings', async ({
  page,
  as,
  pageWithSession,
}) => {
  const owner = as('owner')
  const created = await owner.post('/hubs', {
    name: uniqueHubName('invite grant'),
    color: 'blue',
    idPrefix: 'INV',
  })
  await expectStatus(created, 201)
  const hub = hubListEntrySchema.parse(await created.json())

  // The owner makes an invite link in workspace settings.
  await page.goto(`/w/${WS}/settings/members`)
  await page.getByRole('button', { name: 'Invite people' }).click()
  await page
    .getByRole('dialog', { name: 'Invite people' })
    .getByLabel('Role')
    .selectOption('member')
  await page.getByRole('button', { name: 'Create invite link' }).click()
  const linkDialog = page.getByRole('dialog', { name: 'Invite link' })
  const link = new URL(await linkDialog.getByRole('textbox', { name: 'Invite link' }).inputValue())
  await linkDialog.getByRole('button', { name: 'Done' }).click()

  const tag = crypto.randomUUID().slice(0, 8)
  const person = {
    name: `E2E joiner ${tag}`,
    email: `e2e-joiner-${tag}@example.com`,
    password: `e2e-password-${crypto.randomUUID()}`,
  }
  let principalId = ''
  try {
    // They open it signed out, create their account, and land on their workspaces signed in.
    const joiner = await pageWithSession(null)
    await joiner.goto(link.pathname)
    await expect(joiner.getByRole('heading', { name: 'Accept your invite' })).toBeVisible()
    await joiner.getByLabel('Name').fill(person.name)
    await joiner.getByLabel('Email').fill(person.email)
    await joiner.getByLabel('Password').fill(person.password)
    await joiner.getByRole('button', { name: 'Create account and join' }).click()
    await expect(joiner).toHaveURL(/\/$/)
    await expect(workspaceSection(joiner)).toBeVisible()
    // No grant yet: the new hub is not theirs to see.
    await expect(workspaceSection(joiner).getByText(hub.name)).toHaveCount(0)

    const members = memberPageSchema.parse(await (await owner.get('/members?limit=200')).json())
    const member = members.items.find((m) => m.name === person.name)
    expect(member?.workspaceRole).toBe('member')
    principalId = member?.id ?? ''

    // The owner grants them the hub as editor from its Access settings.
    await page.goto(`/w/${WS}/hubs/${hub.id}/settings/access`)
    const access = page.getByRole('region', { name: 'Access' })
    await access.getByRole('button', { name: 'Add people' }).click()
    const add = page.getByRole('dialog', { name: 'Add people' })
    await add.getByLabel('Person').selectOption({ label: `${person.name} (Member)` })
    await add.getByLabel('Hub role').selectOption('editor')
    await add.getByRole('button', { name: 'Add to hub' }).click()
    await expect(add).toBeHidden()
    await expect(access.getByRole('rowheader', { name: new RegExp(person.name) })).toBeVisible()
    const grants = hubGrantPageSchema.parse(
      await (await owner.get(`/hubs/${hub.id}/grants?limit=200`)).json(),
    )
    expect(grants.items.find((g) => g.principalId === principalId)?.hubRole).toBe('editor')

    // They sign out and back in with their new password; the hub is on their dashboard.
    await joiner.getByRole('button', { name: 'Sign out' }).click()
    await expect(joiner).toHaveURL(/\/sign-in/)
    await joiner.getByLabel('Email').fill(person.email)
    await joiner.getByLabel('Password').fill(person.password)
    await joiner.getByRole('button', { name: 'Sign in' }).click()
    await workspaceSection(joiner)
      .getByRole('link', { name: new RegExp(hub.name) })
      .click()
    await expect(joiner).toHaveURL(new RegExp(`${hubPath(hub.id)}$`))
    await expect(joiner.getByRole('heading', { level: 1, name: hub.name })).toBeVisible()

    // As editor they work with items, but are not offered the hub's settings...
    await expect(joiner.getByRole('button', { name: 'New item' }).first()).toBeVisible()
    await expect(joiner.getByRole('link', { name: 'Hub settings' })).toHaveCount(0)
    // ...and typing the address gets them nothing they can change.
    await joiner.goto(`/w/${WS}/hubs/${hub.id}/settings/general`)
    await expect(joiner.getByText('Only hub admins can rename this hub')).toBeVisible()
    await expect(joiner.getByLabel('Name')).toHaveCount(0)
    await settingsNav(joiner, 'Folders').click()
    await expect(
      joiner.getByText('Only hub admins can change folders and attributes.'),
    ).toBeVisible()
    await expect(joiner.getByRole('button', { name: 'New folder' })).toHaveCount(0)
    await settingsNav(joiner, 'Access').click()
    await expect(joiner.getByText('You cannot see who has access')).toBeVisible()

    // The API refuses them the same, with the session they signed in with.
    const theirs = joiner.context().request
    const asJoiner = (method: 'patch' | 'post' | 'get', path: string, data?: unknown) =>
      theirs[method](`/v1/workspaces/${WS}${path}`, data === undefined ? {} : { data })
    const version = (await describeHub(owner, hub.id)).hub.version
    expect(
      (await asJoiner('patch', `/hubs/${hub.id}`, { version, name: 'Taken over' })).status(),
    ).toBe(403)
    expect(
      (
        await asJoiner('post', `/hubs/${hub.id}/folders`, {
          parentId: hub.id,
          name: 'Nope',
          color: 'red',
        })
      ).status(),
    ).toBe(403)
    expect((await asJoiner('get', `/hubs/${hub.id}/grants`)).status()).toBe(403)
    expect((await describeHub(owner, hub.id)).hub.name).toBe(hub.name)
  } finally {
    // Removing them revokes their grants (docs/ROLES.md); nothing outlives the test.
    if (principalId) {
      const res = await owner.delete(`/members/${encodeURIComponent(principalId)}`)
      expect([204, 404]).toContain(res.status())
    }
  }
})

test('a Number value is saved from the New item form and the item page (#155)', async ({
  page,
  as,
}) => {
  // Known bug #155: the value never reaches the server. Remove this line when it is fixed.
  test.fail()
  const owner = as('owner')
  const made = await owner.post('/hubs', {
    name: uniqueHubName('number'),
    color: 'teal',
    idPrefix: 'NUM',
  })
  await expectStatus(made, 201)
  const hub = hubListEntrySchema.parse(await made.json())
  const res = await owner.post(`/hubs/${hub.id}/attributes`, {
    name: 'Points',
    type: 'number',
    config: { format: 'plain' },
  })
  await expectStatus(res, 201)
  const points = ((await res.json()) as { id: string }).id
  await expectStatus(
    await owner.put(`/folders/${hub.id}/attributes`, {
      version: (await describeHub(owner, hub.id)).hub.version,
      attributes: [{ attributeId: points, required: false }],
    }),
    200,
  )

  await page.goto(hubPath(hub.id))
  await page.getByRole('button', { name: 'New item' }).first().click()
  const form = page.getByRole('complementary', { name: 'New item', exact: true })
  await form.getByLabel('Points').fill('3')
  await form.getByRole('button', { name: 'Create item' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${WS}/items/[^/?]+$`))
  const id = itemIdFromUrl(page)
  expect((await getItem(owner, id)).values[points]).toBe(3)

  const field = page.getByLabel('Points')
  await field.fill('8')
  await field.press('Enter')
  await expect.poll(async () => (await getItem(owner, id)).values[points]).toBe(8)
})
