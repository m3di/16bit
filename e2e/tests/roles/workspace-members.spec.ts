import {
  acceptedInviteSchema,
  createdInviteSchema,
  invitePageSchema,
  inviteTokenSchema,
  memberPageSchema,
  type Invite,
  type WorkspaceRole,
} from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  listAll,
  NO_STATE,
  people,
  test,
  workspaceSection,
  WS,
  type Client,
} from '../support/roles.ts'

// Workspace settings, members and invites (#115), against docs/ROLES.md's workspace table.
// The seeded people are never changed: role changes and removals act on people the spec invites,
// and invites made here are revoked before the test ends.

const membersPath = `/w/${WS}/settings/members`

function peopleTable(page: Page) {
  return page.getByRole('table', { name: 'People in this workspace and their roles' })
}

function memberRow(page: Page, name: string) {
  return peopleTable(page).getByRole('row').filter({ hasText: name })
}

async function roleOf(client: Client, principalId: string): Promise<WorkspaceRole | undefined> {
  const members = await listAll(client, '/members', memberPageSchema)
  return members.find((m) => m.id === principalId)?.workspaceRole
}

async function createInvite(client: Client, workspaceRole: WorkspaceRole): Promise<Invite> {
  const res = await client.post('/invites', { workspaceRole })
  await expectStatus(res, 201)
  return createdInviteSchema.parse(await res.json()).invite
}

/** Counts PATCHes to members sent by the page. */
function countRoleChanges(page: Page): () => number {
  let n = 0
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /\/members\//.test(r.url())) n++
  })
  return () => n
}

function pendingInvites(client: Client): Promise<Invite[]> {
  return listAll(client, '/invites', invitePageSchema)
}

test('an owner opens members from the dashboard, changes a role and removes a person', async ({
  pageAs,
  invite,
  as,
}) => {
  const someone = await invite('member')
  const page = await pageAs('owner')
  await page.goto('/')
  await workspaceSection(page)
    .getByRole('link', { name: /Members and roles/ })
    .click()
  await expect(page).toHaveURL(membersPath)
  await expect(page.getByRole('heading', { level: 1, name: 'Members and roles' })).toBeVisible()
  await expect(page.getByText('You own this workspace.', { exact: false })).toBeVisible()

  // The seeded owner is the only owner: read-only, with the reason.
  await expect(memberRow(page, people.owner.name)).toContainText('The only owner')
  await expect(page.getByLabel(`Role for ${people.owner.name}`)).toHaveCount(0)

  // Change the invited person's role; the server agrees.
  await page.getByLabel(`Role for ${someone.name}`).selectOption('viewer')
  await expect.poll(() => roleOf(as('owner'), someone.principalId)).toBe('viewer')

  // Remove them through the row menu, confirming first.
  await page.getByRole('button', { name: `Actions for ${someone.name}` }).click()
  await page.getByRole('menuitem', { name: 'Remove from workspace' }).click()
  const dialog = page.getByRole('dialog', { name: `Remove ${someone.name}?` })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove from workspace' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'was removed' })).toBeFocused()
  await expect(memberRow(page, someone.name)).toHaveCount(0)
  expect(await roleOf(as('owner'), someone.principalId)).toBeUndefined()
})

test('an owner creates an invite, sees its link once, and revokes it', async ({ pageAs, as }) => {
  const page = await pageAs('owner')
  await page.goto(membersPath)
  const before = new Set((await pendingInvites(as('owner'))).map((i) => i.id))

  await page.getByRole('button', { name: 'Invite people' }).click()
  const dialog = page.getByRole('dialog', { name: 'Invite people' })
  await dialog.getByLabel('Role').selectOption('finance')
  await dialog.getByLabel('Expires after (days)').fill('3')
  await dialog.getByRole('button', { name: 'Create invite link' }).click()

  const linkDialog = page.getByRole('dialog', { name: 'Invite link' })
  const link = linkDialog.getByRole('textbox', { name: 'Invite link' })
  await expect(link).toBeFocused()
  await expect(link).toHaveValue(/\/invite\/[A-Za-z0-9_-]{20,}$/)
  expect(inviteTokenSchema.safeParse((await link.inputValue()).split('/invite/')[1]).success).toBe(
    true,
  )
  // The link can't be shown again, so Escape doesn't close it: only Done does.
  await page.keyboard.press('Escape')
  await expect(linkDialog).toBeVisible()
  await linkDialog.getByRole('button', { name: 'Done' }).click()
  await expect(linkDialog).toBeHidden()

  // Other tests here make invites in parallel; only this one makes finance invites.
  const created = (await pendingInvites(as('owner'))).filter(
    (i) => !before.has(i.id) && i.workspaceRole === 'finance',
  )
  expect(created).toHaveLength(1)
  const id = created[0]?.id ?? ''
  try {
    const row = page.locator(`[data-invite-id="${id}"]`)
    await expect(row).toContainText('Finance')
    await expect(row).toContainText(people.owner.name)
    await row.getByRole('button', { name: /^Revoke/ }).click()
    await expect(row).toHaveCount(0)
    await expect
      .poll(async () => (await pendingInvites(as('owner'))).some((i) => i.id === id))
      .toBe(false)
  } finally {
    await as('owner').post(`/invites/${id}/revoke`)
  }
})

test('a refused role change rolls back and says why', async ({ pageAs, invite }) => {
  const someone = await invite('member')
  const page = await pageAs('owner')
  await page.route(`**/v1/workspaces/${WS}/members/${someone.principalId}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forbidden', message: 'Your role does not allow this' }),
        })
      : route.continue(),
  )
  await page.goto(membersPath)
  const select = page.getByLabel(`Role for ${someone.name}`)
  await select.selectOption('admin')
  await expect(page.getByRole('alert')).toContainText(
    `${someone.name}'s role was not changed to Admin.`,
  )
  await expect(select).toHaveValue('member')
})

test('an admin sees the owner read-only and cannot make owners', async ({ pageAs }) => {
  const page = await pageAs('mina')
  await page.goto(membersPath)
  await expect(
    page.getByText('You are an admin of this workspace.', { exact: false }),
  ).toBeVisible()
  await expect(memberRow(page, people.owner.name)).toContainText('Only owners change owners')
  await expect(page.getByRole('button', { name: `Actions for ${people.owner.name}` })).toHaveCount(
    0,
  )
  const leo = page.getByLabel(`Role for ${people.leo.name}`)
  await expect(leo.locator('option[value="owner"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Invite people' }).click()
  const dialog = page.getByRole('dialog', { name: 'Invite people' })
  await expect(dialog.getByLabel('Role').locator('option[value="owner"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

for (const person of ['leo', 'ivy', 'noor'] as const) {
  test(`${person} (${people[person].role}) sees the read-only member list`, async ({ pageAs }) => {
    const page = await pageAs(person)
    await page.goto(membersPath)
    await expect(memberRow(page, people.owner.name)).toBeVisible()
    await expect(memberRow(page, people[person].name)).toContainText('You')
    await expect(peopleTable(page).getByRole('combobox')).toHaveCount(0)
    await expect(peopleTable(page).getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Invite people' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Pending invites' })).toHaveCount(0)
  })
}

test('the page fits a phone and works by keyboard', async ({ pageAs, invite }) => {
  const someone = await invite('member')
  const page = await pageAs('owner', { width: 390, height: 844 })
  await page.goto(membersPath)
  await expect(peopleTable(page)).toBeVisible()
  // Nothing but the tables' own scroll boxes is wider than the screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  // Keyboard: open the row menu and close it again.
  const menuButton = page.getByRole('button', { name: `Actions for ${someone.name}` })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Remove from workspace' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menuButton).toBeFocused()
})

test('the copied invite link lets a new person join with the chosen role', async ({
  pageAs,
  as,
  playwright,
  baseURL,
}) => {
  const page = await pageAs('owner')
  await page.goto(membersPath)
  await page.getByRole('button', { name: 'Invite people' }).click()
  await page
    .getByRole('dialog', { name: 'Invite people' })
    .getByLabel('Role')
    .selectOption('viewer')
  await page.getByRole('button', { name: 'Create invite link' }).click()
  const url = new URL(await page.getByRole('textbox', { name: 'Invite link' }).inputValue())
  const token = decodeURIComponent(url.pathname.replace(/^\/invite\//, ''))

  const fresh = await playwright.request.newContext({ baseURL, storageState: NO_STATE })
  let principalId = ''
  try {
    const tag = crypto.randomUUID().slice(0, 8)
    const accepted = await fresh.post(`/v1/auth/invites/${encodeURIComponent(token)}`, {
      data: {
        name: `E2E link ${tag}`,
        email: `e2e-link-${tag}@example.com`,
        password: `e2e-password-${crypto.randomUUID()}`,
      },
    })
    await expectStatus(accepted, 201)
    principalId = acceptedInviteSchema.parse(await accepted.json()).principalId
    expect(await roleOf(as('owner'), principalId)).toBe('viewer')
  } finally {
    await fresh.dispose()
    if (principalId) {
      const res = await as('owner').delete(`/members/${encodeURIComponent(principalId)}`)
      expect([204, 404]).toContain(res.status())
    }
  }
})

test('arrowing through a role select sends one change, for the role it stops on', async ({
  pageAs,
  invite,
  as,
}) => {
  const someone = await invite('member')
  const page = await pageAs('owner')
  const patches = countRoleChanges(page)
  await page.goto(membersPath)
  const select = page.getByLabel(`Role for ${someone.name}`)
  await select.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const shown = await select.inputValue()
  expect(shown).not.toBe('member')
  await expect.poll(() => roleOf(as('owner'), someone.principalId)).toBe(shown)
  expect(patches()).toBe(1)
})

test('cancelling a change to your own role keeps the role and the focus', async ({
  invite,
  pageWithSession,
  as,
}) => {
  const admin = await invite('admin')
  const page = await pageWithSession(admin.sid)
  const patches = countRoleChanges(page)
  await page.goto(membersPath)
  const select = page.getByLabel(`Role for ${admin.name}`)
  await select.selectOption('member')
  // Blurring commits at once; the question comes first.
  await select.blur()
  const dialog = page.getByRole('dialog', { name: 'Change your role to Member?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(select).toHaveValue('admin')
  await expect(select).toBeFocused()
  // Nothing was sent, then or after the pause.
  await page.waitForTimeout(1000)
  expect(patches()).toBe(0)
  expect(await roleOf(as('owner'), admin.principalId)).toBe('admin')
})

test('after a revoke, focus skips invites the admin cannot revoke', async ({ pageAs, as }) => {
  // Newest first on the page: mine A, the owner's owner-role invite, mine B.
  const b = await createInvite(as('mina'), 'viewer')
  const ownerInvite = await createInvite(as('owner'), 'owner')
  const a = await createInvite(as('mina'), 'member')
  try {
    const page = await pageAs('mina')
    await page.goto(membersPath)
    const row = (id: string) => page.locator(`[data-invite-id="${id}"]`)
    await expect(row(ownerInvite.id)).toContainText('Only owners revoke')
    // Invites from tests running in parallel may sit between these. Focus must land on the
    // first row after A that has a Revoke button, never on the owner-role row.
    const order = await page.locator('[data-invite-id]').evaluateAll((rows) =>
      rows.map((r) => ({
        id: r.getAttribute('data-invite-id') ?? '',
        revocable: r.querySelector('[data-revoke]') !== null,
      })),
    )
    const at = order.findIndex((r) => r.id === a.id)
    expect(order.slice(at + 1).map((r) => r.id)).toContain(ownerInvite.id)
    const expected = order.slice(at + 1).find((r) => r.revocable)?.id
    // The owner-role row lies between A and the target, so the skip is what is tested.
    const index = (id: string | undefined) => order.findIndex((r) => r.id === id)
    expect(index(expected)).toBeGreaterThan(index(ownerInvite.id))
    await row(a.id)
      .getByRole('button', { name: /^Revoke/ })
      .click()
    await expect(row(a.id)).toHaveCount(0)
    await expect(row(expected ?? '').getByRole('button', { name: /^Revoke/ })).toBeFocused()
  } finally {
    for (const id of [a.id, b.id, ownerInvite.id]) {
      await expectStatus(await as('owner').post(`/invites/${id}/revoke`), 204)
    }
  }
})

test('a workspace the person does not belong to is not available, and not named', async ({
  pageAs,
}) => {
  // Mina belongs to Pixel Works only; Acme Studio is another seeded workspace.
  const page = await pageAs('mina')
  await page.goto('/w/acme/settings/members')
  await expect(page.getByText('This workspace is not available')).toBeVisible()
  await expect(page.getByText('Acme Studio')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Workspace settings' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Back to hubs' })).toBeVisible()
})

// "What each role can do" (issue 138): generated from can(), so it must agree with the API.
function roleTable(page: Page, which: 'workspace' | 'hub') {
  return page.getByRole('table', {
    name:
      which === 'workspace'
        ? 'What each workspace role and an agent key can do in this workspace'
        : 'What each hub role can do inside a hub',
  })
}

function roleCell(page: Page, which: 'workspace' | 'hub', row: string, column: string) {
  const table = roleTable(page, which)
  return table.locator(`tr[data-matrix-row="${row}"] [data-cell="${column}"]`)
}

test('everyone in the workspace sees what each role can do, and the API agrees', async ({
  pageAs,
  as,
}) => {
  const page = await pageAs('leo')
  await page.goto(membersPath)
  await expect(page.getByRole('region', { name: 'What each role can do' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'What each hub role can do' })).toContainText(
    'Viewer and Finance act as viewer at most',
  )
  const sections = page.locator('[data-role-matrix]')
  await expect(roleTable(page, 'workspace').getByRole('columnheader')).toHaveText([
    'Action',
    'Owner',
    'Admin',
    'Member',
    'Viewer',
    'Finance',
    'Agent key',
  ])
  await expect(roleTable(page, 'hub').getByRole('columnheader')).toHaveText([
    'Action',
    'Hub admin',
    'Editor',
    'Commenter',
    'Viewer',
  ])
  // Read-only: no controls in either table.
  await expect(sections.getByRole('button')).toHaveCount(0)
  await expect(sections.getByRole('combobox')).toHaveCount(0)

  // Footnotes ¹ and ³ show as limits.
  await expect(roleCell(page, 'workspace', 'invite', 'owner')).toHaveText('Yes')
  await expect(roleCell(page, 'workspace', 'invite', 'admin')).toContainText('Not owner invites')
  await expect(roleCell(page, 'workspace', 'invite', 'member')).toHaveText('No')
  await expect(roleCell(page, 'workspace', 'billing.manage', 'finance')).toHaveText('Yes')
  await expect(roleCell(page, 'hub', 'item.write', 'commenter')).toHaveText('No')
  await expect(roleCell(page, 'hub', 'grant.change', 'hub_admin')).toContainText(
    'Not their own grant',
  )

  // What the table says a member cannot do, the API refuses Leo, a member.
  const leo = as('leo')
  await expectStatus(await leo.post('/invites', { workspaceRole: 'member' }), 403)
  await expectStatus(
    await leo.post('/hubs', { name: 'Not made', color: 'blue', idPrefix: 'NOP' }),
    403,
  )
})
