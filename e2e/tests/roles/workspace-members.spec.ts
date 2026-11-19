import { invitePageSchema, principalSchema, type Invite } from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
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

async function pendingInvites(client: Client): Promise<Invite[]> {
  const res = await client.get('/invites?limit=200')
  await expectStatus(res, 200)
  return invitePageSchema.parse(await res.json()).items
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
  await expect
    .poll(async () => {
      const res = await as('owner').get('/members?limit=200')
      const list = (await res.json()) as { items: unknown[] }
      return list.items
        .map((m) => principalSchema.parse(m))
        .find((m) => m.id === someone.principalId)?.workspaceRole
    })
    .toBe('viewer')

  // Remove them through the row menu, confirming first.
  await page.getByRole('button', { name: `Actions for ${someone.name}` }).click()
  await page.getByRole('menuitem', { name: 'Remove from workspace' }).click()
  const dialog = page.getByRole('dialog', { name: `Remove ${someone.name}?` })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove from workspace' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'was removed' })).toBeFocused()
  await expect(memberRow(page, someone.name)).toHaveCount(0)
  const res = await as('owner').get('/members?limit=200')
  await expectStatus(res, 200)
  expect(JSON.stringify(await res.json())).not.toContain(someone.principalId)
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
  const link = linkDialog.getByLabel('Invite link')
  await expect(link).toBeFocused()
  await expect(link).toHaveValue(/\/invite\/[A-Za-z0-9_-]{20,}$/)
  await linkDialog.getByRole('button', { name: 'Done' }).click()

  const created = (await pendingInvites(as('owner'))).filter((i) => !before.has(i.id))
  expect(created.map((i) => i.workspaceRole)).toEqual(['finance'])
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
