import {
  attributeSchema,
  folderSchema,
  hubDescriptionSchema,
  hubListEntrySchema,
  type HubDescription,
} from '@16bit/core'
import type { Page } from '@playwright/test'
import { expect, expectStatus, test, uniqueHubName, WS, type Client } from './support/roles.ts'

// Hub settings, folders and attributes (#117): hub admins create, rename, nest and delete empty
// folders; create attributes, edit options and required, attach and reorder them. Removing an
// option or attribute that items use shows the count and asks first (D51). Every test works in
// a hub it creates, so the seeded hubs never change.

const PHONE = { width: 390, height: 844 }

async function newHub(owner: Client) {
  const res = await owner.post('/hubs', {
    name: uniqueHubName('settings'),
    color: 'teal',
    idPrefix: 'SET',
  })
  await expectStatus(res, 201)
  return hubListEntrySchema.parse(await res.json())
}

async function describeHub(client: Client, hubId: string): Promise<HubDescription> {
  const res = await client.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  return hubDescriptionSchema.parse(await res.json())
}

const settings = (hubId: string, section: 'folders' | 'attributes') =>
  `/w/${WS}/hubs/${hubId}/settings/${section}`

async function menu(page: Page, row: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${row}`, exact: true }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

const folderRow = (page: Page, name: string) =>
  page.locator('[data-folder-row]').filter({ has: page.getByRole('rowheader', { name }) })

test('a hub admin creates, nests, renames and deletes folders; a folder with items is refused', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner)
  await page.goto(settings(hub.id, 'folders'))
  await expect(page.getByRole('heading', { level: 1, name: hub.name })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Hub settings' })).toBeVisible()

  // Create two folders, the second inside the first.
  await page.getByRole('button', { name: 'New folder' }).click()
  let dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Name').fill('Planning')
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Created Planning.' })).toBeVisible()

  await menu(page, 'Planning', 'New folder inside')
  dialog = page.getByRole('dialog', { name: 'New folder' })
  await expect(dialog.getByLabel('Inside')).toHaveValue(
    (await describeHub(owner, hub.id)).folders[0]?.id ?? '',
  )
  await dialog.getByLabel('Name').fill('Sprint 1')
  await dialog.getByRole('radio', { name: 'Violet' }).check()
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(dialog).toBeHidden()

  let d = await describeHub(owner, hub.id)
  const planning = d.folders.find((f) => f.name === 'Planning')
  const sprint = d.folders.find((f) => f.name === 'Sprint 1')
  expect(sprint).toMatchObject({ parentId: planning?.id, color: 'violet' })

  // Rename and move Sprint 1 up to the hub.
  await menu(page, 'Sprint 1', 'Rename, recolour or move')
  dialog = page.getByRole('dialog', { name: 'Edit Sprint 1' })
  // A folder can never move under itself.
  await expect(dialog.getByLabel('Inside').locator('option')).toHaveText([hub.name, `– Planning`])
  await dialog.getByLabel('Name').fill('Iteration 1')
  await dialog.getByLabel('Inside').selectOption(hub.id)
  await dialog.getByRole('button', { name: 'Save folder' }).click()
  await expect(dialog).toBeHidden()
  d = await describeHub(owner, hub.id)
  expect(d.folders.find((f) => f.id === sprint?.id)).toMatchObject({
    name: 'Iteration 1',
    parentId: hub.id,
  })

  // A folder holding an item cannot be deleted: the entry says why.
  await owner
    .post('/items', { folderId: planning?.id, values: {} })
    .then((r) => expectStatus(r, 201))
  await page.reload()
  await page.getByRole('button', { name: 'Actions for Planning', exact: true }).click()
  const refused = page.getByRole('menuitem', { name: 'Delete folder' })
  await expect(refused).toHaveAttribute('aria-disabled', 'true')
  await expect(refused).toHaveAccessibleDescription('It still holds items.')
  await page.keyboard.press('Escape')

  // An empty one can.
  await menu(page, 'Iteration 1', 'Delete folder')
  const confirm = page.getByRole('dialog', { name: 'Delete Iteration 1?' })
  await confirm.getByRole('button', { name: 'Delete folder' }).click()
  await expect(confirm).toBeHidden()
  await expect(folderRow(page, 'Iteration 1')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Deleted Iteration 1.' })).toBeFocused()
  // The server agrees: the folder is gone.
  expect((await describeHub(owner, hub.id)).folders.some((f) => f.id === sprint?.id)).toBe(false)
})

test('a folder changed elsewhere is not overwritten: the dialog shows their version', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner)
  const created = await owner.post(`/hubs/${hub.id}/folders`, {
    parentId: hub.id,
    name: 'Backlog',
    color: 'blue',
  })
  await expectStatus(created, 201)
  const folder = folderSchema.parse(await created.json())

  await page.goto(settings(hub.id, 'folders'))
  await expect(folderRow(page, 'Backlog')).toBeVisible()
  // Someone renames it behind the page's back.
  await expectStatus(
    await owner.patch(`/folders/${folder.id}`, { version: folder.version, name: 'Queue' }),
    200,
  )
  await menu(page, 'Backlog', 'Rename, recolour or move')
  const dialog = page.getByRole('dialog', { name: 'Edit Backlog' })
  await dialog.getByLabel('Name').fill('Inbox')
  await dialog.getByRole('button', { name: 'Save folder' }).click()
  // The dialog now shows their version, title included, and says nothing was saved.
  const theirs = page.getByRole('dialog', { name: 'Edit Queue' })
  await expect(theirs.getByRole('alert')).toContainText('your change was not saved')
  await expect(theirs.getByLabel('Name')).toHaveValue('Queue')
  // Not overwritten: the server still has their name, not ours.
  const stored = (await describeHub(owner, hub.id)).folders.find((f) => f.id === folder.id)
  expect(stored?.name).toBe('Queue')
  await expect(folderRow(page, 'Queue')).toBeVisible()
})

test('select, currency and relation attributes; options removed from items ask with the count (D51)', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner)
  await page.goto(settings(hub.id, 'attributes'))
  await expect(page.getByText('No attributes yet')).toBeVisible()

  // A select with two options.
  await page.getByRole('button', { name: 'New attribute' }).click()
  let dialog = page.getByRole('dialog', { name: 'New attribute' })
  await dialog.getByLabel('Name').fill('Stage')
  await dialog.getByRole('radio', { name: 'Select', exact: true }).check()
  await dialog.getByRole('button', { name: 'Add option' }).click()
  await dialog.getByLabel('Name of option 1').fill('To do')
  await dialog.getByRole('button', { name: 'Add option' }).click()
  await dialog.getByLabel('Name of option 2').fill('Done')
  await dialog.getByRole('switch', { name: 'Filter and sort' }).click()
  await dialog.getByRole('button', { name: 'Create attribute' }).click()
  await expect(dialog).toBeHidden()

  // A currency number; a missing code is caught before sending.
  await page.getByRole('button', { name: 'New attribute' }).click()
  dialog = page.getByRole('dialog', { name: 'New attribute' })
  await dialog.getByLabel('Name').fill('Budget')
  await dialog.getByRole('radio', { name: 'Number' }).check()
  await dialog.getByLabel('Format').selectOption('currency')
  await dialog.getByRole('button', { name: 'Create attribute' }).click()
  await expect(dialog.getByText('Use a three-letter currency code')).toBeVisible()
  await dialog.getByLabel('Currency code').fill('eur')
  await dialog.getByRole('button', { name: 'Create attribute' }).click()
  await expect(dialog).toBeHidden()

  // A relation into this hub.
  await page.getByRole('button', { name: 'New attribute' }).click()
  dialog = page.getByRole('dialog', { name: 'New attribute' })
  await dialog.getByLabel('Name').fill('Blocks')
  await dialog.getByRole('radio', { name: 'Relation' }).check()
  await expect(dialog.getByLabel('Links to items in')).toHaveValue(hub.id)
  await dialog.getByRole('button', { name: 'Create attribute' }).click()
  await expect(dialog).toBeHidden()

  const d = await describeHub(owner, hub.id)
  const byName = Object.fromEntries(d.attributes.map((a) => [a.name, a]))
  expect(byName['Stage']).toMatchObject({ type: 'select', indexed: true })
  expect(byName['Budget']).toMatchObject({
    type: 'number',
    config: { format: 'currency', currency: 'EUR' },
  })
  expect(byName['Blocks']).toMatchObject({
    type: 'relation',
    config: { targetHubId: hub.id, crossHub: false, multiple: true },
  })
  const stage = attributeSchema.parse(byName['Stage'])
  if (stage.type !== 'select') throw new Error('Stage is not a select')
  const done = stage.config.options.find((o) => o.label === 'Done')

  // One item holds "Done".
  await expectStatus(
    await owner.put(`/folders/${hub.id}/attributes`, {
      version: d.hub.version,
      attributes: [{ attributeId: stage.id, required: false }],
    }),
    200,
  )
  const item = await owner.post('/items', { folderId: hub.id, values: { [stage.id]: done?.id } })
  await expectStatus(item, 201)
  const { id: itemId } = (await item.json()) as { id: string }

  // The type is shown, never offered; removing Done asks with the count.
  await page.reload()
  await menu(page, 'Stage', 'Edit')
  dialog = page.getByRole('dialog', { name: 'Edit Stage' })
  await expect(dialog.getByRole('radio')).toHaveCount(0)
  await expect(dialog.getByText('The type cannot change once the attribute exists.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Actions for option 2, Done' }).click()
  await page.getByRole('menuitem', { name: 'Remove option' }).click()
  await dialog.getByRole('button', { name: 'Save attribute' }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove options from Stage?' })
  await expect(confirm).toContainText('1 item holds an option you removed from Stage.')
  await confirm.getByRole('button', { name: 'Remove options and save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Saved Stage.' })).toBeVisible()

  const after = await owner.get(`/items/${itemId}`)
  expect(
    ((await after.json()) as { values: Record<string, unknown> }).values[stage.id] ?? null,
  ).toBe(null)
})

test('deleting an attribute items use asks again with the count', async ({ page, as }) => {
  const owner = as('owner')
  const hub = await newHub(owner)
  const res = await owner.post(`/hubs/${hub.id}/attributes`, {
    name: 'Points',
    type: 'number',
    config: { format: 'plain' },
  })
  await expectStatus(res, 201)
  const points = attributeSchema.parse(await res.json())
  const d = await describeHub(owner, hub.id)
  await expectStatus(
    await owner.put(`/folders/${hub.id}/attributes`, {
      version: d.hub.version,
      attributes: [{ attributeId: points.id, required: false }],
    }),
    200,
  )
  for (const value of [1, 2]) {
    await expectStatus(
      await owner.post('/items', { folderId: hub.id, values: { [points.id]: value } }),
      201,
    )
  }

  await page.goto(settings(hub.id, 'attributes'))
  await menu(page, 'Points', 'Delete attribute')
  const confirm = page.getByRole('dialog', { name: 'Delete Points?', exact: true })
  await expect(confirm).toContainText(`It leaves ${hub.name}.`)
  await confirm.getByRole('button', { name: 'Delete attribute' }).click()
  // Nothing is cleared yet: the server answered with the count. It comes in a dialog of its
  // own, so the count is read as it opens, and Cancel, not the destructive action, has focus.
  await expect(confirm).toBeHidden()
  const count = page.getByRole('dialog', { name: 'Clear values and delete Points?' })
  await expect(count).toHaveAccessibleDescription(/^2 items hold a value for Points\./)
  await expect(count.getByRole('button', { name: 'Cancel' })).toBeFocused()
  expect((await describeHub(owner, hub.id)).attributes).toHaveLength(1)
  await count.getByRole('button', { name: 'Clear values and delete' }).click()
  await expect(count).toBeHidden()
  await expect(page.getByText('No attributes yet')).toBeVisible()
  expect((await describeHub(owner, hub.id)).attributes).toHaveLength(0)
})

test('a folder shows the count of items a new required attribute leaves empty, before and after saving (D51)', async ({
  page,
  as,
}) => {
  const owner = as('owner')
  const hub = await newHub(owner)
  const made = await owner.post(`/hubs/${hub.id}/attributes`, {
    name: 'Owner note',
    type: 'text',
    config: {},
  })
  await expectStatus(made, 201)
  const note = attributeSchema.parse(await made.json())
  const sized = await owner.post(`/hubs/${hub.id}/attributes`, {
    name: 'Size',
    type: 'boolean',
    config: {},
  })
  await expectStatus(sized, 201)
  const size = attributeSchema.parse(await sized.json())
  for (let i = 0; i < 3; i++) {
    await expectStatus(await owner.post('/items', { folderId: hub.id, values: {} }), 201)
  }

  await page.goto(settings(hub.id, 'folders'))
  // Count the dry runs: only a change to which attributes are required sends one (D51).
  const dryRuns: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'PUT' && (r.postDataJSON() as { dryRun?: boolean } | null)?.dryRun === true)
      dryRuns.push(r.url())
  })
  await menu(page, hub.name, 'Attributes')
  const dialog = page.getByRole('dialog', { name: `Attributes in ${hub.name}` })
  await expect(dialog.getByText('This folder shows no attributes yet.')).toBeVisible()
  for (const name of ['Owner note (Text)', 'Size (Checkbox)']) {
    await dialog.getByLabel('Add an attribute').selectOption({ label: name })
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  }
  // Reorder: Size first.
  await dialog.getByRole('button', { name: 'Actions for Size' }).click()
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  await page.waitForTimeout(400)
  expect(dryRuns).toHaveLength(0)
  await dialog.getByRole('switch', { name: 'Owner note is required' }).click()
  await expect(dialog.getByText(`3 items in ${hub.name} leave it empty.`)).toBeVisible()
  expect(dryRuns).toHaveLength(1)
  // The dry run saved nothing.
  expect((await describeHub(owner, hub.id)).folderAttributes).toHaveLength(0)

  await dialog.getByRole('button', { name: 'Save attributes' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status')).toContainText(
    `Owner note: 3 items in ${hub.name} leave it empty.`,
  )
  const saved = (await describeHub(owner, hub.id)).folderAttributes
    .sort((a, b) => a.position - b.position)
    .map((fa) => [fa.attributeId, fa.required])
  expect(saved).toEqual([
    [size.id, false],
    [note.id, true],
  ])
})

test('readers who are not hub admins see the schema read-only; a hidden hub is not found', async ({
  pageAs,
}) => {
  // Leo is a viewer of Design.
  const leo = await pageAs('leo')
  await leo.goto(settings('design', 'attributes'))
  await expect(leo.getByText('Only hub admins can change folders and attributes.')).toBeVisible()
  await expect(leo.locator('[data-attribute-row]').first()).toBeVisible()
  await expect(leo.getByRole('button', { name: 'New attribute' })).toHaveCount(0)
  await expect(leo.getByRole('button', { name: /^Actions for / })).toHaveCount(0)

  // The hub page offers the way in only to hub admins, owners and admins.
  await leo.goto(`/w/${WS}/hubs/design`)
  await expect(leo.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(leo.getByRole('link', { name: 'Hub settings' })).toHaveCount(0)

  // Mina is an admin with no grant on Design: it is a 404, and its name does not show (D45).
  const mina = await pageAs('mina')
  await mina.goto(settings('design', 'folders'))
  await expect(mina.getByText('This hub is not available')).toBeVisible()
  await expect(mina.getByText('Design')).toHaveCount(0)
  await expect(mina.getByRole('navigation', { name: 'Hub settings' })).toHaveCount(0)
})

test('the hub page links hub admins to settings, and the page fits a phone', async ({
  pageAs,
  page,
}) => {
  await page.goto(`/w/${WS}/hubs/design`)
  await page.getByRole('link', { name: 'Hub settings' }).click()
  // It opens on General, the first section (#116).
  await expect(page).toHaveURL(new RegExp(`/w/${WS}/hubs/design/settings/general$`))
  await page
    .getByRole('navigation', { name: 'Hub settings' })
    .getByRole('link', { name: 'Attributes' })
    .click()
  await expect(page.getByRole('heading', { name: 'Attributes', level: 2 })).toBeVisible()

  const phone = await pageAs('owner', PHONE)
  await phone.goto(settings('design', 'folders'))
  await expect(phone.locator('[data-folder-row]').first()).toBeVisible()
  // Nothing but the tables' own scroll boxes is wider than the screen.
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
