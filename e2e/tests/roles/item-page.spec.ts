import { attributeSchema, hubDescriptionSchema, hubListEntrySchema, type Item } from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  itemPanel,
  test,
  uniqueHubName,
  uniqueTitle,
  type Client,
} from '../support/roles.ts'

// The item page (#119): an item opened by ID, titled by its hub's title attribute (D50), with
// every attribute of its folder, relations with "no access", backlinks with the hidden count,
// and delete for editors.
//
// Each test builds its own hub, so setting the title attribute and grants touches nothing
// seeded. The owner is its hub admin; Ivy is a viewer there and has no grant on Design; Leo is
// a viewer of Design and has no grant on the new hub.

const DESIGN_TITLE = 'design-title'

interface Built {
  hubId: string
  hubName: string
  title: string
  refs: string
  parent: string
}

async function created<T>(
  res: Promise<import('@playwright/test').APIResponse>,
  schema: {
    parse(v: unknown): T
  },
) {
  const r = await res
  await expectStatus(r, 201)
  return schema.parse(await r.json())
}

/** A hub with Title (its title attribute), Refs (into Design) and Parent (inside the hub). */
async function buildHub(owner: Client): Promise<Built> {
  const hubName = uniqueHubName('item page')
  const hub = await created(
    owner.post('/hubs', { name: hubName, color: 'violet', idPrefix: 'ITP' }),
    hubListEntrySchema,
  )
  const attr = (body: Record<string, unknown>) =>
    created(owner.post(`/hubs/${hub.id}/attributes`, body), attributeSchema)
  const title = await attr({ name: 'Title', type: 'text', config: {} })
  const refs = await attr({
    name: 'Refs',
    type: 'relation',
    config: { targetHubId: 'design', crossHub: true, multiple: true },
  })
  const parent = await attr({
    name: 'Parent',
    type: 'relation',
    config: { targetHubId: hub.id, crossHub: false, multiple: false },
  })
  const describe = async () => {
    const res = await owner.get(`/hubs/${hub.id}`)
    await expectStatus(res, 200)
    return hubDescriptionSchema.parse(await res.json())
  }
  await expectStatus(
    await owner.put(`/folders/${hub.id}/attributes`, {
      version: (await describe()).hub.version,
      attributes: [
        { attributeId: title.id, required: true },
        { attributeId: refs.id },
        { attributeId: parent.id },
      ],
    }),
    200,
  )
  await expectStatus(
    await owner.patch(`/hubs/${hub.id}`, {
      version: (await describe()).hub.version,
      titleAttributeId: title.id,
    }),
    200,
  )
  await expectStatus(await owner.put(`/hubs/${hub.id}/grants/ivy`, { hubRole: 'viewer' }), 200)
  return { hubId: hub.id, hubName, title: title.id, refs: refs.id, parent: parent.id }
}

const itemPath = (id: string) => `/w/demo/items/${id}`
const details = (page: Page) => page.getByRole('complementary', { name: 'Details' })
const linkedFrom = (page: Page) => page.locator('[data-backlinks]')

test('an editor opens an item on its own page, edits it and follows its links', async ({
  as,
  pageAs,
}) => {
  const owner = as('owner')
  const h = await buildHub(owner)
  const design = await owner.createItem('design', { [DESIGN_TITLE]: uniqueTitle('design ref') })
  const name = uniqueTitle('page item')
  const item = await owner.createItem(h.hubId, { [h.title]: name, [h.refs]: [design.id] })
  const child = await owner.createItem(h.hubId, {
    [h.title]: uniqueTitle('child'),
    [h.parent]: [item.id],
  })

  const page = await pageAs('owner')
  // The table's panel links to the page.
  await page.goto(`${hubPath(h.hubId)}?item=${item.id}`)
  await itemPanel(page).getByRole('link', { name: 'Open page' }).click()
  await expect(page).toHaveURL(new RegExp(`${itemPath(item.id)}$`))

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  const trail = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(trail.getByRole('link', { name: h.hubName })).toBeVisible()
  await expect(trail).toContainText(`ITP-${String(item.seqId)}`)

  // Every attribute of the folder, with its editor. The linked Design item shows its title.
  const refs = page.getByRole('list', { name: 'Refs' })
  await expect(
    refs.getByRole('link', { name: design.values[DESIGN_TITLE] as string }),
  ).toBeVisible()

  // Backlinks: the child links here through Parent.
  const backlink = linkedFrom(page).locator(`[data-backlink="${child.id}"]`)
  await expect(backlink).toContainText('in Parent')
  await expect(details(page).locator('[data-item-version]')).toHaveText('1')

  // Rename it here: the title follows and the server has the new value.
  const renamed = uniqueTitle('renamed')
  const field = page.getByLabel('Title (required)')
  await field.fill(renamed)
  await field.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed)
  await expect(details(page).locator('[data-item-version]')).toHaveText('2')
  await expect
    .poll(async () => {
      const res = await owner.get(`/items/${item.id}`)
      return ((await res.json()) as Item).values[h.title]
    })
    .toBe(renamed)

  // A backlink opens the linking item's page.
  await backlink.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`${itemPath(child.id)}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(child.values[h.title] as string)
})

test('a viewer sees the item read-only, a linked item they cannot see as "No access"', async ({
  as,
  pageAs,
}) => {
  const owner = as('owner')
  const h = await buildHub(owner)
  const hidden = uniqueTitle('hidden design')
  const design = await owner.createItem('design', { [DESIGN_TITLE]: hidden })
  const name = uniqueTitle('viewer item')
  const item = await owner.createItem(h.hubId, { [h.title]: name, [h.refs]: [design.id] })

  const page = await pageAs('ivy')
  await page.goto(itemPath(item.id))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  await expect(page.getByText('You can view this item but not change it.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0)
  await expect(page.getByLabel('Title (required)')).toBeDisabled()

  const refs = page.getByRole('list', { name: 'Refs' })
  await expect(refs.locator('[data-access="none"]')).toBeVisible()
  await expect(page.getByText(hidden)).toHaveCount(0)
  await expect(linkedFrom(page)).toContainText('No items link here.')
})

test('backlinks from items the reader cannot see are counted, never named', async ({
  as,
  pageAs,
}) => {
  const owner = as('owner')
  const h = await buildHub(owner)
  const design = await owner.createItem('design', { [DESIGN_TITLE]: uniqueTitle('target') })
  const secret = uniqueTitle('secret source')
  await owner.createItem(h.hubId, { [h.title]: secret, [h.refs]: [design.id] })

  // Leo can view Design but holds no grant on the new hub.
  const page = await pageAs('leo')
  await page.goto(itemPath(design.id))
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(linkedFrom(page)).toContainText('1 link from an item you cannot see.')
  await expect(page.getByText(secret)).toHaveCount(0)
  await expect(page.getByText('You can view this item but not change it.')).toBeVisible()
})

test('a hidden or missing item reads as not available', async ({ as, pageAs }) => {
  const owner = as('owner')
  const h = await buildHub(owner)
  const name = uniqueTitle('not for leo')
  const item = await owner.createItem(h.hubId, { [h.title]: name })

  const page = await pageAs('leo')
  for (const id of [item.id, crypto.randomUUID()]) {
    await page.goto(itemPath(id))
    await expect(page.getByText('This item is not available')).toBeVisible()
    await expect(
      page.getByText('It may not exist, or it may not be shared with you.'),
    ).toBeVisible()
    await expect(page.getByText(name)).toHaveCount(0)
  }
})

test('an editor deletes an item after confirming; a stale version is refused', async ({
  as,
  pageAs,
}) => {
  const owner = as('owner')
  const h = await buildHub(owner)
  const item = await owner.createItem(h.hubId, { [h.title]: uniqueTitle('to delete') })

  const page = await pageAs('owner')
  await page.goto(itemPath(item.id))
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // Someone else changes it first: the delete is refused and the latest values show.
  const theirs = uniqueTitle('their edit')
  await expectStatus(
    await owner.patch(`/items/${item.id}`, { version: 1, values: { [h.title]: theirs } }),
    200,
  )
  await page.getByRole('button', { name: 'Delete item' }).click()
  const dialog = page.getByRole('dialog', { name: `Delete ITP-${String(item.seqId)}?` })
  await dialog.getByRole('button', { name: 'Delete item' }).click()
  await expect(dialog.getByRole('alert')).toContainText('changed by someone else')
  await expect(page.getByLabel('Title (required)')).toHaveValue(theirs)
  await expectStatus(await owner.get(`/items/${item.id}`), 200)

  // Asked again at the version now shown, it goes, and the page returns to the hub.
  await dialog.getByRole('button', { name: 'Delete item' }).click()
  await expect(page).toHaveURL(new RegExp(`${hubPath(h.hubId)}$`))
  await expectStatus(await owner.get(`/items/${item.id}`), 404)
})

test('the item page fits a phone screen', async ({ as, pageAs }) => {
  const owner = as('owner')
  const h = await buildHub(owner)
  const name = uniqueTitle('phone')
  const item = await owner.createItem(h.hubId, { [h.title]: name })

  const page = await pageAs('owner', { width: 390, height: 844 })
  await page.goto(itemPath(item.id))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
