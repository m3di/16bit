import {
  hubDescriptionSchema,
  hubListEntrySchema,
  hubPageSchema,
  type HubListEntry,
} from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  people,
  test,
  uniqueHubName,
  uniqueTitle,
  workspaceSection,
  type Client,
} from '../support/roles.ts'

// docs/ROLES.md, "Two layers" and the hub rows of "Workspace actions": who sees which hubs,
// that a hub without a grant is a 404 for everyone (owners and admins included, D45), creating
// hubs, granting and revoking, and self-granting (API only in M1).

const SEEDED = ['Archive', 'Design', 'Hiring', 'Launch', 'Product', 'Support']
const PHONE = { width: 390, height: 844 }

async function hubList(client: Client): Promise<HubListEntry[]> {
  const res = await client.get('/hubs?limit=200')
  await expectStatus(res, 200)
  return hubPageSchema.parse(await res.json()).items
}

/** Seeded hubs in the list, by name, with the caller's access to each. */
async function seededAccess(client: Client) {
  const hubs = await hubList(client)
  return Object.fromEntries(
    hubs
      .filter((h) => SEEDED.includes(h.name))
      .map((h) => [h.name, h.access === 'granted' ? h.hubRole : 'none']),
  )
}

function hubCard(page: Page, name: string) {
  return workspaceSection(page).getByRole('listitem').filter({ hasText: name })
}

test('owners and admins see every hub name; everyone else only the hubs they hold a grant on', async ({
  as,
  agentKey,
}) => {
  expect(await seededAccess(as('owner'))).toEqual({
    Archive: 'hub_admin',
    Design: 'hub_admin',
    Hiring: 'hub_admin',
    Launch: 'hub_admin',
    Product: 'hub_admin',
    Support: 'hub_admin',
  })
  expect(await seededAccess(as('mina'))).toEqual({
    Archive: 'none',
    Design: 'none',
    Hiring: 'none',
    Launch: 'editor',
    Product: 'editor',
    Support: 'hub_admin',
  })
  expect(await seededAccess(as('leo'))).toEqual({
    Design: 'viewer',
    Launch: 'editor',
    Product: 'editor',
    Support: 'commenter',
  })
  // Viewer and finance act as viewer at most, whatever the grant says.
  expect(await seededAccess(as('ivy'))).toEqual({ Launch: 'viewer', Product: 'viewer' })
  expect(await seededAccess(as('noor'))).toEqual({ Support: 'viewer' })

  const { client: agent } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  expect((await hubList(agent)).map((h) => h.name)).toEqual(['Product'])
})

for (const [label, viewport] of [
  ['desktop', undefined],
  ['phone', PHONE],
] as const) {
  test(`an admin's hubs without a grant show "No access" and are not links (${label})`, async ({
    pageAs,
  }) => {
    const page = await pageAs('mina', viewport)
    await page.goto('/')
    for (const name of ['Design', 'Hiring', 'Archive']) {
      const card = hubCard(page, name)
      await expect(card).toBeVisible()
      await expect(card).toContainText('No access')
      await expect(card).not.toContainText(/\d+ items?/)
      await expect(card.getByRole('link')).toHaveCount(0)
      // Fits the screen: nothing is cut off at the right edge.
      const box = await card.boundingBox()
      expect(box && box.x + box.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? Infinity)
    }
    for (const name of ['Launch', 'Product', 'Support']) {
      const card = hubCard(page, name)
      await expect(card.getByRole('link', { name: new RegExp(`^${name}\\b`) })).toBeVisible()
      await expect(card).not.toContainText('No access')
    }
  })
}

test('a member sees only granted hubs on the dashboard, and others are not available', async ({
  pageAs,
  as,
}) => {
  const page = await pageAs('leo')
  await page.goto('/')
  for (const name of ['Design', 'Launch', 'Product', 'Support']) {
    await expect(hubCard(page, name).getByRole('link')).toBeVisible()
  }
  await expect(workspaceSection(page).getByRole('link', { name: /^Product\b/ })).toBeVisible()
  for (const name of ['Hiring', 'Archive']) await expect(hubCard(page, name)).toHaveCount(0)
  await expect(workspaceSection(page)).not.toContainText('No access')

  // Typing the address of a hub without a grant reads like a missing hub.
  await page.goto(hubPath('hiring'))
  await expect(page.getByText('This hub is not available')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expectStatus(await as('leo').get('/hubs/hiring'), 404)
})

test('without a grant, everything inside a hub is a 404, for owners and admins too', async ({
  as,
  pageAs,
}) => {
  // The owner holds every seeded grant, so an item in Design exists.
  const item = await as('owner').createItem('design', { 'design-title': uniqueTitle('hidden') })
  const mina = as('mina')
  const missing = await mina.get('/hubs/no-such-hub')
  await expectStatus(missing, 404)

  // Mina is a workspace admin without a grant on Design (D45).
  const hidden = await mina.get('/hubs/design')
  await expectStatus(hidden, 404)
  // Hidden and missing look the same, so hubs can't be probed.
  expect((await hidden.json()) as unknown).toEqual((await missing.json()) as unknown)
  await expectStatus(await mina.post('/query', { from: 'design', limit: 1 }), 404)
  await expectStatus(await mina.post('/query', { from: 'design-mockups', limit: 1 }), 404)
  await expectStatus(await mina.get(`/items/${item.id}`), 404)
  await expectStatus(await mina.get(`/items/${item.id}/backlinks`), 404)
  await expectStatus(
    await mina.patch(`/items/${item.id}`, { version: 1, values: { 'design-title': 'x' } }),
    404,
  )
  await expectStatus(await mina.delete(`/items/${item.id}?version=1`), 404)
  await expectStatus(
    await mina.post('/items', { folderId: 'design', values: { 'design-title': 'x' } }),
    404,
  )
  // A hub with no grant at all, for someone who doesn't even see its name.
  await expectStatus(await as('noor').get(`/items/${item.id}`), 404)

  // In the browser: the hub and the item read as missing.
  const page = await pageAs('mina')
  await page.goto(`${hubPath('design')}?item=${item.id}`)
  await expect(page.getByText('This hub is not available')).toBeVisible()
  await expect(page.getByText(item.values['design-title'] as string)).toHaveCount(0)
})

test('owners and admins create hubs and become their hub admin; nobody else can', async ({
  as,
  agentKey,
}) => {
  for (const person of ['owner', 'mina'] as const) {
    const res = await as(person).post('/hubs', {
      name: uniqueHubName(`by ${person}`),
      color: 'lime',
      idPrefix: 'EZE',
    })
    await expectStatus(res, 201)
    const hub = hubListEntrySchema.parse(await res.json())
    expect(hub).toMatchObject({ access: 'granted', hubRole: 'hub_admin' })
    const described = await as(person).get(`/hubs/${hub.id}`)
    await expectStatus(described, 200)
    expect(hubDescriptionSchema.parse(await described.json()).hubRole).toBe('hub_admin')
  }
  for (const person of ['leo', 'ivy', 'noor'] as const) {
    await expectStatus(
      await as(person).post('/hubs', {
        name: uniqueHubName('refused'),
        color: 'lime',
        idPrefix: 'EZE',
      }),
      403,
    )
  }
  const { client: agent } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  await expectStatus(
    await agent.post('/hubs', { name: uniqueHubName('refused'), color: 'lime', idPrefix: 'EZE' }),
    403,
  )
})

for (const [creator, granter] of [
  ['owner', 'mina'],
  ['mina', 'owner'],
] as const) {
  test(`${granter === 'owner' ? 'an owner' : 'an admin'} without a grant sees "No access" until they grant themselves access`, async ({
    as,
    pageAs,
  }) => {
    const name = uniqueHubName(`self-grant ${granter}`)
    const created = await as(creator).post('/hubs', { name, color: 'teal', idPrefix: 'SLF' })
    await expectStatus(created, 201)
    const hub = hubListEntrySchema.parse(await created.json())
    const me = as(granter)

    expect((await hubList(me)).find((h) => h.id === hub.id)?.access).toBe('none')
    await expectStatus(await me.get(`/hubs/${hub.id}`), 404)
    await expectStatus(await me.post('/query', { from: hub.id, limit: 1 }), 404)

    const page = await pageAs(granter)
    await page.goto('/')
    await expect(hubCard(page, name)).toContainText('No access')
    await expect(hubCard(page, name).getByRole('link')).toHaveCount(0)

    // Self-granting is API-only in M1 (D45, D48).
    const id = people[granter].id
    await expectStatus(await me.put(`/hubs/${hub.id}/grants/${id}`, { hubRole: 'viewer' }), 200)
    await expectStatus(await me.get(`/hubs/${hub.id}`), 200)

    await page.reload()
    await hubCard(page, name).getByRole('link').click()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  })
}

test('owners and admins grant and revoke on any hub; other roles cannot', async ({
  as,
  invite,
  pageWithSession,
  agentKey,
}) => {
  const someone = await invite('member')
  const grant = (hubId: string) => `/hubs/${hubId}/grants/${someone.principalId}`

  await expectStatus(await someone.client.get('/hubs/archive'), 404)
  await expectStatus(await as('owner').put(grant('archive'), { hubRole: 'viewer' }), 200)
  await expectStatus(await someone.client.get('/hubs/archive'), 200)
  const page = await pageWithSession(someone.sid)
  await page.goto('/')
  await expect(hubCard(page, 'Archive').getByRole('link', { name: /^Archive\b/ })).toBeVisible()
  // Mina holds no grant on Archive and still manages access to it, as an admin.
  await expectStatus(await as('mina').put(grant('archive'), { hubRole: 'editor' }), 200)
  expect(
    hubDescriptionSchema.parse(await (await someone.client.get('/hubs/archive')).json()).hubRole,
  ).toBe('editor')

  // Not a hub admin anywhere it matters: Leo is commenter on Support, Noor viewer.
  await expectStatus(await as('leo').put(grant('support'), { hubRole: 'viewer' }), 403)
  await expectStatus(await as('noor').put(grant('support'), { hubRole: 'viewer' }), 403)
  await expectStatus(await as('leo').delete(grant('archive')), 404)
  await expectStatus(await as('ivy').put(grant('product'), { hubRole: 'viewer' }), 403)
  const { client: agent, key } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  await expectStatus(await agent.put(grant('product'), { hubRole: 'viewer' }), 403)

  // Footnote ¹: an admin cannot set, change or revoke an owner's grant (the seeded owner is the
  // only owner there can be, see workspace.spec.ts). An agent's grant comes with its key.
  await expectStatus(
    await as('mina').put(`/hubs/archive/grants/${people.owner.id}`, { hubRole: 'viewer' }),
    403,
  )
  await expectStatus(await as('mina').delete(`/hubs/archive/grants/${people.owner.id}`), 403)
  await expectStatus(
    await as('owner').put(`/hubs/product/grants/${key.id}`, { hubRole: 'viewer' }),
    403,
  )

  // Revoked: Archive is gone from their dashboard and every read is a 404 again.
  await expectStatus(await as('mina').delete(grant('archive')), 204)
  await expectStatus(await someone.client.get('/hubs/archive'), 404)
  expect((await hubList(someone.client)).map((h) => h.name)).not.toContain('Archive')
  await page.reload()
  await expect(workspaceSection(page).getByRole('heading', { level: 2 })).toBeVisible()
  await expect(hubCard(page, 'Archive')).toHaveCount(0)
})

test('a hub admin grants on their hub, but not on their own grant or an owner or admin', async ({
  as,
  invite,
}) => {
  const admin = await invite('member')
  const other = await invite('member')
  const wsAdmin = await invite('admin')
  await expectStatus(
    await as('owner').put(`/hubs/archive/grants/${admin.principalId}`, { hubRole: 'hub_admin' }),
    200,
  )
  const hubAdmin = admin.client

  // Footnote ³: any hub role, hub admin included, for others.
  await expectStatus(
    await hubAdmin.put(`/hubs/archive/grants/${other.principalId}`, { hubRole: 'commenter' }),
    200,
  )
  await expectStatus(await other.client.get('/hubs/archive'), 200)
  await expectStatus(
    await hubAdmin.put(`/hubs/archive/grants/${other.principalId}`, { hubRole: 'hub_admin' }),
    200,
  )
  await expectStatus(await hubAdmin.delete(`/hubs/archive/grants/${other.principalId}`), 204)
  await expectStatus(await other.client.get('/hubs/archive'), 404)

  // Not their own grant, and not a workspace owner's or admin's. The admin is one this test
  // invited, so a regression can't change a seeded person's grants.
  await expectStatus(
    await as('owner').put(`/hubs/archive/grants/${wsAdmin.principalId}`, { hubRole: 'viewer' }),
    200,
  )
  await expectStatus(
    await hubAdmin.put(`/hubs/archive/grants/${admin.principalId}`, { hubRole: 'editor' }),
    403,
  )
  await expectStatus(await hubAdmin.delete(`/hubs/archive/grants/${admin.principalId}`), 403)
  await expectStatus(await hubAdmin.delete(`/hubs/archive/grants/${people.owner.id}`), 403)
  await expectStatus(
    await hubAdmin.put(`/hubs/archive/grants/${wsAdmin.principalId}`, { hubRole: 'editor' }),
    403,
  )
  await expectStatus(await hubAdmin.delete(`/hubs/archive/grants/${wsAdmin.principalId}`), 403)
  expect(
    hubDescriptionSchema.parse(await (await wsAdmin.client.get('/hubs/archive')).json()).hubRole,
  ).toBe('viewer')
  // Only on this hub: they hold no grant on Hiring.
  await expectStatus(
    await hubAdmin.put(`/hubs/hiring/grants/${other.principalId}`, { hubRole: 'viewer' }),
    404,
  )
})
