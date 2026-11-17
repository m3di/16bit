import { expect, test as setup } from '@playwright/test'
import { DEV_PASSWORD, people, stateFile, type Person } from './support/auth-state.ts'

// Runs before every spec (the `setup` project in playwright.config.ts): signs each seeded
// person in once through the real form and saves the session for the specs and their API
// clients. One sign-in per person per run keeps the suite far below the per-email rate limit.
// No spec signs these sessions out: the sign-out spec uses an account of its own.
for (const person of Object.keys(people) as Person[]) {
  setup(`sign in as ${person}`, async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill(people[person].email)
    await page.getByLabel('Password').fill(DEV_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).not.toHaveURL(/\/sign-in/)
    await page.context().storageState({ path: stateFile(person) })
  })
}
