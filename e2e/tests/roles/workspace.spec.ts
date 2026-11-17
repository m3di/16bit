import { createdInviteSchema, principalSchema, pageSchema } from '@16bit/core'
import { expect, expectStatus, people, test, workspaceSection, WS_NAME } from '../support/roles.ts'

// docs/ROLES.md, "Workspace actions": the workspace and its member list, invites, role
// changes and removal. Owners and admins manage members; nobody else does; agents do nothing.
// Renaming or deleting the workspace, deleting a hub, and billing have no route in M1.

const memberPage = pageSchema(principalSchema)

test('every person sees the workspace and its member list; an agent key sees neither list', async ({
  as,
  pageAs,
  agentKey,
}) => {
  for (const person of ['owner', 'mina', 'leo', 'ivy', 'noor'] as const) {
    const res = await as(person).get('/members?limit=200')
    await expectStatus(res, 200)
    const names = memberPage.parse(await res.json()).items.map((m) => m.name)
    expect(names, person).toEqual(expect.arrayContaining(Object.values(people).map((p) => p.name)))
  }

  // In the browser: the workspace is on the dashboard of the least privileged person.
  const page = await pageAs('noor')
  await page.goto('/')
  await expect(
    workspaceSection(page).getByRole('heading', { level: 2, name: WS_NAME }),
  ).toBeVisible()

  // An agent key sees its own workspace's ID and name, never its members.
  const { client: agent } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  const workspaces = await agent.get('/v1/workspaces')
  await expectStatus(workspaces, 200)
  expect(((await workspaces.json()) as { items: { id: string }[] }).items.map((w) => w.id)).toEqual(
    ['demo'],
  )
  await expectStatus(await agent.get('/members'), 403)
})

test('only owners and admins invite, and an admin cannot invite an owner', async ({
  as,
  agentKey,
  invite,
}) => {
  // Every invite made here is accepted and the person removed again: M1 has no route to revoke
  // an invite. The `invite` fixture is the owner inviting. An owner inviting an owner isn't
  // tested: a second owner would let the seeded one step down in a parallel test.
  const byAdmin = await invite('member', { by: as('mina') })
  await expectStatus(await byAdmin.client.get('/hubs'), 200)
  await expectStatus(await as('mina').post('/invites', { workspaceRole: 'owner' }), 403)
  for (const person of ['leo', 'ivy', 'noor'] as const) {
    await expectStatus(await as(person).post('/invites', { workspaceRole: 'viewer' }), 403)
  }
  const { client: agent } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  await expectStatus(await agent.post('/invites', { workspaceRole: 'viewer' }), 403)
})

test('owners and admins change roles; an admin cannot touch an owner; the last owner stays', async ({
  as,
  invite,
  agentKey,
}) => {
  const someone = await invite('member')
  const path = `/members/${someone.principalId}`

  const byOwner = await as('owner').patch(path, { workspaceRole: 'viewer' })
  await expectStatus(byOwner, 200)
  expect(principalSchema.parse(await byOwner.json()).workspaceRole).toBe('viewer')
  const byAdmin = await as('mina').patch(path, { workspaceRole: 'finance' })
  await expectStatus(byAdmin, 200)
  expect(principalSchema.parse(await byAdmin.json()).workspaceRole).toBe('finance')

  // Footnote ¹: an admin cannot make an owner or change one. The only owner there can be is the
  // seeded one (see the invite test above).
  await expectStatus(await as('mina').patch(path, { workspaceRole: 'owner' }), 403)
  await expectStatus(
    await as('mina').patch(`/members/${people.owner.id}`, { workspaceRole: 'admin' }),
    403,
  )
  // Nobody else changes roles, the invited person included.
  for (const person of ['leo', 'ivy', 'noor'] as const) {
    await expectStatus(await as(person).patch(path, { workspaceRole: 'member' }), 403)
  }
  await expectStatus(await someone.client.patch(path, { workspaceRole: 'admin' }), 403)
  const { client: agent } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  await expectStatus(await agent.patch(path, { workspaceRole: 'member' }), 403)

  // The seeded owner is the only owner of Pixel Works and cannot step down.
  await expectStatus(
    await as('owner').patch(`/members/${people.owner.id}`, { workspaceRole: 'admin' }),
    403,
  )
})

test('owners and admins remove members, who then lose the workspace', async ({
  as,
  invite,
  pageWithSession,
}) => {
  const removedByAdmin = await invite('member')
  const removedByOwner = await invite('viewer')

  for (const person of ['leo', 'ivy', 'noor'] as const) {
    await expectStatus(await as(person).delete(`/members/${removedByAdmin.principalId}`), 403)
  }
  await expectStatus(await as('mina').delete(`/members/${people.owner.id}`), 403)

  await expectStatus(await removedByAdmin.client.get('/hubs'), 200)
  await expectStatus(await as('mina').delete(`/members/${removedByAdmin.principalId}`), 204)
  await expectStatus(await as('owner').delete(`/members/${removedByOwner.principalId}`), 204)
  // The workspace no longer exists for them.
  await expectStatus(await removedByAdmin.client.get('/hubs'), 404)
  await expectStatus(await removedByOwner.client.get('/members'), 404)

  // The member list no longer names them.
  const list = await as('leo').get('/members?limit=200')
  const names = memberPage.parse(await list.json()).items.map((m) => m.name)
  expect(names).not.toContain(removedByAdmin.name)
  expect(names).not.toContain(removedByOwner.name)

  // Their session still signs them in, but the dashboard has no Pixel Works for them.
  const page = await pageWithSession(removedByAdmin.sid)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible()
  await expect(workspaceSection(page)).toHaveCount(0)
})

test('removing a member expires their unused invites; their agent keys stay until revoked', async ({
  as,
  invite,
  agentKey,
  anonymous,
}) => {
  const admin = await invite('admin')
  const created = await admin.client.post('/invites', { workspaceRole: 'viewer' })
  await expectStatus(created, 201)
  const { token } = createdInviteSchema.parse(await created.json())
  await expectStatus(
    await as('owner').put(`/hubs/archive/grants/${admin.principalId}`, { hubRole: 'viewer' }),
    200,
  )
  const { client: agent, key } = await agentKey({
    hubId: 'archive',
    hubRole: 'viewer',
    creator: admin.client,
  })

  await expectStatus(await as('owner').delete(`/members/${admin.principalId}`), 204)

  // Their invite can no longer be accepted.
  const tag = crypto.randomUUID().slice(0, 8)
  await expectStatus(
    await anonymous.post(`/v1/auth/invites/${token}`, {
      name: `E2E late ${tag}`,
      email: `e2e-late-${tag}@example.com`,
      password: `e2e-password-${crypto.randomUUID()}`,
    }),
    404,
  )
  // Their key still works, in its hub, until someone revokes it.
  await expectStatus(await agent.get('/v1/me'), 200)
  await expectStatus(await agent.get('/hubs/archive'), 200)
  await expectStatus(await as('owner').post(`/agent-keys/${key.id}/revoke`), 200)
  await expectStatus(await agent.get('/v1/me'), 401)
})
