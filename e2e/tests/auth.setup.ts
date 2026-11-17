import { expect, test as setup } from '@playwright/test'
import { OWNER_STATE, owner } from './support/auth-state.ts'

// Runs before every spec (the `setup` project in playwright.config.ts): signs in once through
// the real form as the seeded owner and saves the session for the specs and the `api` fixture.
// One sign-in per run keeps the suite far below the per-email rate limit.
setup('sign in as the seeded owner', async ({ page }) => {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
  await page.context().storageState({ path: OWNER_STATE })
})
