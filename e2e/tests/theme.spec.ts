import { expect, test } from './support/fixtures.ts'

const STORAGE_KEY = '16bit.theme'

// The page background a person sees, from the theme tokens in apps/web/src/styles/tokens.css.
const background = { light: 'rgb(255, 255, 255)', dark: 'rgb(15, 17, 21)' }

async function pageBackground(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.querySelector('#app > *') ?? document.body).backgroundColor,
  )
}

test('a stored dark choice is applied before the first paint', async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, 'dark')
    // Record the theme class at the moment <body> is parsed. That is before the app's own code
    // runs and before anything can paint, so a light class here would be a light flash.
    new MutationObserver((_records, observer) => {
      // <body> is typed as always there, but it is not while <head> is being parsed.
      if (!document.querySelector('body')) return
      observer.disconnect()
      document.documentElement.dataset['e2eThemeAtBody'] = document.documentElement.className
    }).observe(document, { childList: true, subtree: true })
  }, STORAGE_KEY)

  await page.goto('/')

  await expect(page.locator('html')).toHaveAttribute('data-e2e-theme-at-body', 'theme-dark')
  await expect(page.locator('html')).toHaveClass('theme-dark')
  await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark')
  expect(await pageBackground(page)).toBe(background.dark)
})

test('switching the theme updates the page and is kept after a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const theme = page.getByRole('combobox', { name: 'Theme' })
  await expect(theme).toHaveValue('system')
  await expect(page.locator('html')).toHaveClass('theme-light')

  await theme.selectOption({ label: 'Dark' })
  await expect(page.locator('html')).toHaveClass('theme-dark')
  await expect.poll(() => pageBackground(page)).toBe(background.dark)

  await page.reload()
  await expect(page.locator('html')).toHaveClass('theme-dark')
  await expect(theme).toHaveValue('dark')

  await theme.selectOption({ label: 'Light' })
  await expect(page.locator('html')).toHaveClass('theme-light')
  await expect.poll(() => pageBackground(page)).toBe(background.light)
})

test('the system theme follows the operating system setting', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('system')
  await expect(page.locator('html')).toHaveClass('theme-dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass('theme-light')
})
