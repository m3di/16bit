import { hubDescriptionSchema, itemSchema, type Item } from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  itemPanel,
  itemsTable,
  people,
  test,
  uniqueTitle,
  type Client,
} from '../support/roles.ts'

// docs/ROLES.md, "Hub actions (by effective hub role)": everyone with a grant reads and
// queries; hub admins and editors create, edit and delete; commenters and viewers don't, and
// viewer and finance people act as viewers whatever their grant says. Launch has an attribute
// of every M1 type (#51).

const TITLE = 'launch-title'
const READ_ONLY = 'You can view the items in this hub but not add or change them.'

async function getItem(client: Client, id: string): Promise<Item> {
  const res = await client.get(`/items/${id}`)
  await expectStatus(res, 200)
  return itemSchema.parse(await res.json())
}

async function openItem(page: Page, item: Item) {
  await page.goto(`${hubPath(item.hubId)}?item=${item.id}`)
  await expect(itemPanel(page).getByLabel('Title (required)')).toHaveValue(
    item.values[TITLE] as string,
  )
}

test('the effective hub role is each person’s grant capped by their workspace role', async ({
  as,
}) => {
  const cases = [
    ['mina', 'support', 'hub_admin'],
    ['leo', 'launch', 'editor'],
    ['leo', 'support', 'commenter'],
    ['leo', 'design', 'viewer'],
    // Ivy's editor grant on Launch acts as viewer: she is a workspace viewer.
    ['ivy', 'launch', 'viewer'],
    ['noor', 'support', 'viewer'],
  ] as const
  for (const [person, hubId, role] of cases) {
    const res = await as(person).get(`/hubs/${hubId}`)
    await expectStatus(res, 200)
    expect(hubDescriptionSchema.parse(await res.json()).hubRole, `${person} on ${hubId}`).toBe(role)
  }
})

test('hub admins and editors create, edit and delete items', async ({ as }) => {
  for (const [person, hubId, title] of [
    ['mina', 'support', 'support-title'],
    ['leo', 'launch', TITLE],
  ] as const) {
    const client = as(person)
    const item = await client.createItem(hubId, { [title]: uniqueTitle(`by ${person}`) })
    expect(item.updatedBy).toBe(people[person].id)
    const edited = await client.patch(`/items/${item.id}`, {
      version: 1,
      values: { [title]: uniqueTitle('edited') },
    })
    await expectStatus(edited, 200)
    await expectStatus(await client.delete(`/items/${item.id}?version=2`), 204)
    await expectStatus(await client.get(`/items/${item.id}`), 404)
  }
})

test('commenters, viewers and finance read and query but cannot write', async ({ as }) => {
  const launch = await as('owner').createItem('launch', { [TITLE]: uniqueTitle('read only') })
  const support = await as('owner').createItem('support', {
    'support-title': uniqueTitle('read only'),
  })

  for (const [person, item, title] of [
    ['leo', support, 'support-title'],
    ['noor', support, 'support-title'],
    ['ivy', launch, TITLE],
  ] as const) {
    const client = as(person)
    expect((await getItem(client, item.id)).values[title]).toBe(item.values[title])
    await expectStatus(await client.post('/query', { from: item.hubId, limit: 1 }), 200)
    await expectStatus(
      await client.post('/items', { folderId: item.hubId, values: { [title]: 'x' } }),
      403,
    )
    await expectStatus(
      await client.patch(`/items/${item.id}`, { version: 1, values: { [title]: 'x' } }),
      403,
    )
    await expectStatus(await client.delete(`/items/${item.id}?version=1`), 403)
  }
  // Nothing changed.
  expect((await getItem(as('owner'), launch.id)).version).toBe(1)
  expect((await getItem(as('owner'), support.id)).version).toBe(1)
})

test('an editor adds an item and edits it in the browser', async ({ pageAs, as }) => {
  const page = await pageAs('leo')
  const name = uniqueTitle('leo creates')
  await page.goto(hubPath('launch'))
  await expect(page.getByText(READ_ONLY)).toHaveCount(0)
  await page.getByRole('button', { name: 'New item' }).click()
  const form = page.getByRole('complementary', { name: 'New item', exact: true })
  await form.getByLabel('Title (required)').fill(name)
  await form.getByRole('button', { name: 'Create item' }).click()

  const row = itemsTable(page, 'Launch').getByRole('row').filter({ hasText: name })
  await expect(row.getByRole('link', { name: /^LCH-\d+$/ })).toBeVisible()
  const id = new URL(page.url()).searchParams.get('item')
  expect(id).not.toBeNull()
  const stored = await getItem(as('owner'), id ?? '')
  expect(stored).toMatchObject({ updatedBy: people.leo.id, values: { [TITLE]: name } })
})

test.describe('read-only from the hub role', () => {
  // The hub description carries hubRole since #73; the page doesn't use it yet (#90).
  test.fixme(true, 'The hub page shows read-only only after a refused write (#90)')

  for (const [person, item] of [
    ['ivy', { hubId: 'launch', folder: 'Launch' }],
    ['noor', { hubId: 'support', folder: 'Support' }],
    ['leo', { hubId: 'support', folder: 'Support' }],
  ] as const) {
    test(`${person} sees ${item.folder} read-only before trying to change anything`, async ({
      pageAs,
    }) => {
      const page = await pageAs(person)
      await page.goto(hubPath(item.hubId))
      await expect(itemsTable(page, item.folder)).toBeVisible()
      await expect(page.getByText(READ_ONLY)).toBeVisible()
      await expect(page.getByRole('button', { name: 'New item' })).toHaveCount(0)
      await page
        .getByRole('link', { name: /^[A-Z]+-\d+$/ })
        .first()
        .click()
      await expect(itemPanel(page).getByRole('textbox').first()).not.toBeEditable()
    })
  }
})

test('a grant lowered while the page is open refuses the edit, which rolls back', async ({
  as,
  invite,
  pageWithSession,
}) => {
  const someone = await invite('member')
  const grant = `/hubs/archive/grants/${someone.principalId}`
  await expectStatus(await as('owner').put(grant, { hubRole: 'editor' }), 200)
  const title = uniqueTitle('lowered')
  const item = await as('owner').createItem('archive', { 'archive-title': title })

  const page = await pageWithSession(someone.sid)
  await page.goto(`${hubPath('archive')}?item=${item.id}`)
  const field = itemPanel(page).getByLabel('Title (required)')
  await expect(field).toHaveValue(title)
  await expect(page.getByRole('button', { name: 'New item' })).toBeVisible()

  await expectStatus(await as('owner').put(grant, { hubRole: 'viewer' }), 200)
  await field.fill(uniqueTitle('not saved'))
  await field.press('Enter')

  await expect(page.getByText(/was not saved/)).toBeVisible()
  await expect(field).toHaveValue(title)
  await expect(page.getByText(READ_ONLY)).toBeVisible()
  await expect(page.getByRole('button', { name: 'New item' })).toHaveCount(0)
  expect((await getItem(as('owner'), item.id)).version).toBe(1)
})

test('an editor types in the rich text editor and it is saved', async ({ as, pageAs }) => {
  const item = await as('leo').createItem('launch', { [TITLE]: uniqueTitle('rich text') })
  const page = await pageAs('leo')
  await openItem(page, item)

  const notes = itemPanel(page).getByRole('textbox', { name: 'Notes' })
  await notes.click()
  const words = `Typed by Leo ${crypto.randomUUID().slice(0, 8)}`
  await page.keyboard.type(words)
  await expect(notes).toContainText(words)
  // Saved when the editor loses focus.
  await itemPanel(page).getByLabel('Title (required)').focus()

  await expect
    .poll(async () => JSON.stringify((await getItem(as('owner'), item.id)).values['launch-notes']))
    .toContain(words)
  await page.reload()
  await expect(itemPanel(page).getByRole('textbox', { name: 'Notes' })).toContainText(words)
})

test('an editor links an item through the relation picker, which focuses its search box', async ({
  as,
  pageAs,
}) => {
  const leo = as('leo')
  const from = await leo.createItem('launch', { [TITLE]: uniqueTitle('depends') })
  const target = await leo.createItem('launch', { [TITLE]: uniqueTitle('dependency') })
  const targetTitle = target.values[TITLE] as string
  const page = await pageAs('leo')
  await openItem(page, from)

  const field = itemPanel(page).getByRole('group', { name: 'Depends on' })
  await field.getByRole('button', { name: 'Link an item' }).click()
  const search = field.getByRole('searchbox', { name: 'Search Launch' })
  await expect(search).toBeFocused()
  await search.fill(targetTitle)
  await search.press('Enter')
  await field
    .getByRole('list', { name: 'Items to link to Depends on' })
    .getByRole('button', { name: new RegExp(targetTitle) })
    .click()

  await expect(
    field.getByRole('list', { name: 'Depends on' }).getByRole('link', { name: targetTitle }),
  ).toBeVisible()
  await expect
    .poll(async () => (await getItem(as('owner'), from.id)).values['launch-depends'])
    .toEqual([target.id])
})

test('multi-select chips stay on one line in a table cell', async ({ as, pageAs }) => {
  const title = uniqueTitle('chips')
  await as('owner').createItem('launch', {
    [TITLE]: title,
    'launch-tags': ['web', 'api', 'docs'],
  })
  const page = await pageAs('ivy')
  await page.goto(hubPath('launch'))
  const row = itemsTable(page, 'Launch').getByRole('row').filter({ hasText: title })
  const tags = row.getByRole('list', { name: 'Tags' })
  await expect(tags.getByRole('listitem')).toHaveText(['Web', 'API', /\+1/])

  // One line: every entry is centred on the same line, none wrapped below another.
  const centres = await tags.getByRole('listitem').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return r.top + r.height / 2
    }),
  )
  for (const c of centres) expect(Math.abs(c - (centres[0] ?? 0))).toBeLessThanOrEqual(1)
})
