import { expect, expectStatus, NO_STATE, test, workspaceSection } from '../support/roles.ts'

// docs/ROLES.md, "Answers to errors": not signed in is a 401, and the dashboard sends you to
// sign in. There is no development key any more (#51), so a dead session falls back to nothing.
// These tests use people they invite, never a seeded person's session, which other specs share.

test('without a session the API answers 401 and the dashboard asks you to sign in', async ({
  anonymous,
  pageWithSession,
}) => {
  for (const path of ['/v1/me', '/v1/workspaces', '/hubs', '/members', '/hubs/product']) {
    await expectStatus(await anonymous.get(path), 401)
  }
  await expectStatus(await anonymous.post('/query', { from: 'product', limit: 1 }), 401)
  await expectStatus(
    await anonymous.post('/items', { folderId: 'product', values: { 'product-title': 'x' } }),
    401,
  )

  const page = await pageWithSession(null)
  await page.goto('/w/demo/hubs/product')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})

test('signing out ends the session for the browser and the API', async ({
  invite,
  pageWithSession,
  bearer,
}) => {
  const someone = await invite('member')
  const page = await pageWithSession(someone.sid)
  await page.goto('/')
  await expect(workspaceSection(page)).toBeVisible()
  await expectStatus(await someone.client.get('/v1/me'), 200)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in/)

  // The old cookie is dead everywhere.
  await expectStatus(await someone.client.get('/v1/me'), 401)
  await expectStatus(await someone.client.get('/hubs'), 401)
  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(workspaceSection(page)).toHaveCount(0)

  // A garbage bearer token is a 401 too, not a fallback to anyone.
  const nobody = await bearer('not-a-key')
  await expectStatus(await nobody.get('/v1/me'), 401)
})

test('a session that ends while the page is open sends you to sign in', async ({
  invite,
  pageWithSession,
  playwright,
  baseURL,
}) => {
  const someone = await invite('member')
  const page = await pageWithSession(someone.sid)
  await page.goto('/')
  await expect(workspaceSection(page)).toBeVisible()

  // Signed out elsewhere, with the same cookie.
  const elsewhere = await playwright.request.newContext({
    storageState: NO_STATE,
    baseURL,
    extraHTTPHeaders: { Cookie: `sid=${someone.sid}` },
  })
  await expectStatus(await elsewhere.post('/v1/auth/logout'), 204)
  await elsewhere.dispose()

  await page.goto('/w/demo/hubs/product')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('signing in with a wrong password is refused', async ({ pageWithSession, invite }) => {
  const someone = await invite('viewer')
  const page = await pageWithSession(null)
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(someone.email)
  await page.getByLabel('Password').fill(`${someone.password}-wrong`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page).toHaveURL(/\/sign-in/)

  await page.getByLabel('Password').fill(someone.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
  await expect(workspaceSection(page)).toBeVisible()
})
