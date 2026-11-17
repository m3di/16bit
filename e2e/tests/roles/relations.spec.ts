import { backlinkPageSchema, itemReadSchema } from '@16bit/core'
import {
  expect,
  expectStatus,
  hubPath,
  itemPanel,
  test,
  uniqueTitle,
  type Client,
} from '../support/roles.ts'

// docs/ROLES.md, "Relations across hubs": a linked item is seen only by those who could read it
// directly; to everyone else it is "no access", never its values. Backlinks from unreadable
// items are counted, never named.

const TITLE = 'launch-title'
const DEPENDS = 'launch-depends'
/** Seeded in #91: a Launch relation into Design that allows crossing hubs. */
const DESIGN_REFS = 'launch-design'

async function read(client: Client, id: string, expand: string) {
  const res = await client.get(`/items/${id}?expand=${expand}`)
  await expectStatus(res, 200)
  return itemReadSchema.parse(await res.json())
}

test('an agent key expands a relation inside its hub', async ({ as, agentKey }) => {
  const target = await as('owner').createItem('launch', { [TITLE]: uniqueTitle('target') })
  const from = await as('owner').createItem('launch', {
    [TITLE]: uniqueTitle('from'),
    [DEPENDS]: [target.id],
  })
  const { client: agent } = await agentKey({ hubId: 'launch', hubRole: 'viewer' })
  const item = await read(agent, from.id, DEPENDS)
  expect(item.linked?.[target.id]).toMatchObject({
    access: 'read',
    item: { values: { [TITLE]: target.values[TITLE] } },
  })
})

test.describe('links into a hub the reader has no grant on', () => {
  test('an agent key expanding a link into another hub gets "no access" (D28)', async ({
    as,
    agentKey,
  }) => {
    const design = await as('owner').createItem('design', {
      'design-title': uniqueTitle('secret design'),
    })
    const from = await as('owner').createItem('launch', {
      [TITLE]: uniqueTitle('links design'),
      [DESIGN_REFS]: [design.id],
    })
    const { client: agent } = await agentKey({ hubId: 'launch', hubRole: 'editor' })

    const item = await read(agent, from.id, DESIGN_REFS)
    expect(item.linked?.[design.id]).toEqual({ access: 'none' })
    expect(JSON.stringify(item)).not.toContain(design.values['design-title'] as string)
    const query = await agent.post('/query', {
      from: 'launch',
      where: null,
      limit: 1,
      expand: [DESIGN_REFS],
      sort: [],
    })
    await expectStatus(query, 200)
    expect(await query.text()).not.toContain(design.values['design-title'] as string)
    await expectStatus(await agent.get(`/items/${design.id}`), 404)

    // The Design item's backlinks are a 404 to the key; to the owner, the link is named.
    await expectStatus(await agent.get(`/items/${design.id}/backlinks`), 404)
    const backlinks = backlinkPageSchema.parse(
      await (await as('owner').get(`/items/${design.id}/backlinks`)).json(),
    )
    expect(backlinks.items.map((b) => b.item.id)).toContain(from.id)
  })

  test('a linked item in a hub without a grant shows "No access" and no title', async ({
    as,
    pageAs,
  }) => {
    const secret = uniqueTitle('secret design')
    const design = await as('owner').createItem('design', { 'design-title': secret })
    const from = await as('owner').createItem('launch', {
      [TITLE]: uniqueTitle('links design'),
      [DESIGN_REFS]: [design.id],
    })

    // Mina: admin, editor of Launch, no grant on Design.
    const page = await pageAs('mina')
    await page.goto(`${hubPath('launch')}?item=${from.id}`)
    const field = itemPanel(page).getByRole('group', { name: 'Design refs' })
    await expect(field.getByText('No access')).toBeVisible()
    await expect(field.getByRole('link')).toHaveCount(0)
    await expect(page.getByText(secret)).toHaveCount(0)
    expect(await page.content()).not.toContain(secret)

    // Leo is a viewer of Design: the same link shows its title.
    const leo = await pageAs('leo')
    await leo.goto(`${hubPath('launch')}?item=${from.id}`)
    await expect(
      itemPanel(leo)
        .getByRole('group', { name: 'Design refs' })
        .getByRole('link', { name: secret }),
    ).toBeVisible()
  })
})
