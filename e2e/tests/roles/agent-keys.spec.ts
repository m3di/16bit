import { agentKeyPageSchema, meSchema } from '@16bit/core'
import { readFileSync } from 'node:fs'
import { stateFile } from '../support/auth-state.ts'
import { expect, expectStatus, NO_STATE, people, test, uniqueTitle } from '../support/roles.ts'

// docs/ROLES.md, "Agent keys" and the key rows of "Workspace actions" and "Hub actions". A key
// is its own principal with one hub grant (D47) and no workspace actions (D28). Agents have no
// dashboard in M1, so these are API checks. The seeded Triage bot key's secret is printed
// once by `pnpm seed` and not kept, so every test makes the keys it uses.

test('a key acts in its one hub, as its own principal, and nowhere else', async ({
  agentKey,
  as,
}) => {
  const { client: agent, key } = await agentKey({ hubId: 'product', hubRole: 'editor' })

  const me = meSchema.parse(await (await agent.get('/v1/me')).json())
  expect(me).toMatchObject({
    kind: 'agent',
    principalId: key.id,
    workspace: { id: 'demo', name: 'Pixel Works' },
    hub: { id: 'product', name: 'Product' },
    hubRole: 'editor',
  })

  // Reads and writes in its hub; the write is its own.
  await expectStatus(await agent.post('/query', { from: 'product', limit: 1 }), 200)
  const item = await agent.createItem('product', { 'product-title': uniqueTitle('by a key') })
  expect(item.updatedBy).toBe(key.id)

  // Every other hub is missing, including ones its creator can read.
  const design = await as('owner').createItem('design', {
    'design-title': uniqueTitle('not for keys'),
  })
  await expectStatus(await agent.get('/hubs/design'), 404)
  await expectStatus(await agent.get(`/items/${design.id}`), 404)
  await expectStatus(await agent.post('/query', { from: 'design', limit: 1 }), 404)
  await expectStatus(
    await agent.post('/items', { folderId: 'design', values: { 'design-title': 'x' } }),
    404,
  )
})

test('a key never manages members, grants, keys or hubs', async ({ agentKey }) => {
  const { client: agent, key } = await agentKey({ hubId: 'product', hubRole: 'editor' })
  const refused = [
    agent.get('/members'),
    agent.post('/invites', { workspaceRole: 'viewer' }),
    agent.patch(`/members/${people.leo.id}`, { workspaceRole: 'viewer' }),
    agent.delete(`/members/${people.leo.id}`),
    agent.post('/hubs', { name: 'Zz e2e by a key', color: 'lime', idPrefix: 'KEY' }),
    agent.put(`/hubs/product/grants/${people.leo.id}`, { hubRole: 'viewer' }),
    agent.delete(`/hubs/product/grants/${people.leo.id}`),
    agent.post('/hubs/product/agent-keys', { name: 'child', hubRole: 'viewer' }),
    agent.get('/hubs/product/agent-keys'),
    agent.post(`/agent-keys/${key.id}/revoke`),
  ]
  for (const res of await Promise.all(refused)) await expectStatus(res, 403)
})

test('commenter and viewer keys read but cannot write', async ({ agentKey }) => {
  for (const hubRole of ['commenter', 'viewer'] as const) {
    const { client: agent } = await agentKey({ hubId: 'product', hubRole })
    await expectStatus(await agent.post('/query', { from: 'product', limit: 1 }), 200)
    await expectStatus(
      await agent.post('/items', { folderId: 'product', values: { 'product-title': 'x' } }),
      403,
    )
  }
})

test('owners and admins with a grant create keys up to their own hub role; others cannot', async ({
  as,
  agentKey,
  invite,
}) => {
  // Mina: admin, editor of Product, hub admin of Support, no grant on Design.
  await agentKey({ hubId: 'product', hubRole: 'editor', creator: 'mina' })
  await agentKey({ hubId: 'support', hubRole: 'viewer', creator: 'mina' })
  const body = { name: 'E2E refused key', hubRole: 'viewer' }
  await expectStatus(await as('mina').post('/hubs/design/agent-keys', body), 403)
  // Never hub admin (D28).
  await expectStatus(
    await as('owner').post('/hubs/product/agent-keys', { ...body, hubRole: 'hub_admin' }),
    400,
  )
  // Leo is an editor of Product, but only owners, admins and hub admins make keys.
  await expectStatus(await as('leo').post('/hubs/product/agent-keys', body), 403)
  await expectStatus(await as('ivy').post('/hubs/product/agent-keys', body), 403)
  await expectStatus(await as('noor').post('/hubs/product/agent-keys', body), 404)

  // Least privilege: an admin holding a viewer grant makes viewer keys only.
  const admin = await invite('admin')
  await expectStatus(
    await as('owner').put(`/hubs/archive/grants/${admin.principalId}`, { hubRole: 'viewer' }),
    200,
  )
  await expectStatus(
    await admin.client.post('/hubs/archive/agent-keys', { ...body, hubRole: 'editor' }),
    403,
  )
  const viewerKey = await admin.client.post('/hubs/archive/agent-keys', body)
  await expectStatus(viewerKey, 201)
  const { key } = (await viewerKey.json()) as { key: { id: string } }
  await expectStatus(await as('owner').post(`/agent-keys/${key.id}/revoke`), 200)

  // A member who is hub admin of a hub makes keys for it.
  const hubAdmin = await invite('member')
  await expectStatus(
    await as('owner').put(`/hubs/archive/grants/${hubAdmin.principalId}`, { hubRole: 'hub_admin' }),
    200,
  )
  const made = await hubAdmin.client.post('/hubs/archive/agent-keys', {
    ...body,
    hubRole: 'editor',
  })
  await expectStatus(made, 201)
  const listed = await hubAdmin.client.get('/hubs/archive/agent-keys')
  await expectStatus(listed, 200)
  const madeKey = ((await made.json()) as { key: { id: string } }).key
  expect(agentKeyPageSchema.parse(await listed.json()).items.map((k) => k.id)).toContain(madeKey.id)
  await expectStatus(await hubAdmin.client.post(`/agent-keys/${madeKey.id}/revoke`), 200)
})

test('the people who can create keys on a hub list them; others cannot', async ({
  as,
  agentKey,
}) => {
  const { key } = await agentKey({ hubId: 'product', hubRole: 'viewer' })
  for (const person of ['owner', 'mina'] as const) {
    const res = await as(person).get('/hubs/product/agent-keys?limit=200')
    await expectStatus(res, 200)
    const names = agentKeyPageSchema.parse(await res.json()).items.map((k) => k.name)
    expect(names).toContain(key.name)
    // The key `pnpm seed` makes.
    expect(names).toContain('Triage bot')
  }
  await expectStatus(await as('leo').get('/hubs/product/agent-keys'), 403)
  await expectStatus(await as('ivy').get('/hubs/product/agent-keys'), 403)
  await expectStatus(await as('noor').get('/hubs/product/agent-keys'), 404)
  // An admin without a grant on the hub sees its name, not its keys.
  await expectStatus(await as('mina').get('/hubs/design/agent-keys'), 403)
})

test('owners and admins revoke any key, and a revoked key gets 401', async ({ as, agentKey }) => {
  // Mina has no grant on Design; revoking needs none (footnote ²).
  const { client: agent, key } = await agentKey({ hubId: 'design', hubRole: 'editor' })
  await expectStatus(await agent.get('/v1/me'), 200)

  await expectStatus(await as('leo').post(`/agent-keys/${key.id}/revoke`), 403)
  await expectStatus(await as('noor').post(`/agent-keys/${key.id}/revoke`), 403)
  await expectStatus(await agent.get('/v1/me'), 200)

  const revoked = await as('mina').post(`/agent-keys/${key.id}/revoke`)
  await expectStatus(revoked, 200)
  expect(((await revoked.json()) as { revokedAt: string | null }).revokedAt).not.toBeNull()
  await expectStatus(await agent.get('/v1/me'), 401)
  await expectStatus(await agent.post('/query', { from: 'design', limit: 1 }), 401)
})

test('an unknown key and an expired key get 401', async ({ as, bearer }) => {
  const unknown = await bearer('16b_this-is-not-a-real-key-at-all-0000000000')
  await expectStatus(await unknown.get('/v1/me'), 401)
  await expectStatus(await unknown.get('/hubs'), 401)

  const res = await as('owner').post('/hubs/product/agent-keys', {
    name: 'E2E expiring key',
    hubRole: 'viewer',
    expiresAt: new Date(Date.now() + 3_000).toISOString(),
  })
  await expectStatus(res, 201)
  const { key, secret } = (await res.json()) as { key: { id: string }; secret: string }
  const expiring = await bearer(secret)
  await expect
    .poll(async () => (await expiring.get('/v1/me')).status(), { timeout: 15_000 })
    .toBe(401)
  await expectStatus(await as('owner').post(`/agent-keys/${key.id}/revoke`), 200)
})

test('a request with both a session and a key is refused (D49)', async ({
  agentKey,
  playwright,
  baseURL,
}) => {
  const { secret } = await agentKey({ hubId: 'product', hubRole: 'viewer' })
  const state = JSON.parse(readFileSync(stateFile('owner'), 'utf8')) as {
    cookies: { name: string; value: string }[]
  }
  const sid = state.cookies.find((c) => c.name === 'sid')?.value ?? ''
  const both = await playwright.request.newContext({
    storageState: NO_STATE,
    baseURL,
    extraHTTPHeaders: { Cookie: `sid=${sid}`, Authorization: `Bearer ${secret}` },
  })
  await expectStatus(await both.get('/v1/me'), 400)
  await both.dispose()
})
