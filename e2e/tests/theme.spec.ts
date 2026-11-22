import { expect, test } from './support/fixtures.ts'

const STORAGE_KEY = '16bit.theme'

// The page background a person sees, from the theme tokens in apps/web/src/styles/tokens.css.
const background = { light: 'rgb(255, 255, 255)', dark: 'rgb(15, 17, 21)' }

async function pageBackground(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.querySelector('#app > *') ?? document.body).backgroundColor,
  )
}

const toDark = { name: 'Switch to dark theme' }
const toLight = { name: 'Switch to light theme' }

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
  await expect(page.getByRole('button', toLight)).toBeVisible()
  expect(await pageBackground(page)).toBe(background.dark)
})

test('the theme button switches the page and its icon, and is kept after a reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveClass('theme-light')
  const switchToDark = page.getByRole('button', toDark)
  await expect(switchToDark.locator('svg')).toHaveAttribute('data-glyph', 'moon')

  await switchToDark.click()
  await expect(page.locator('html')).toHaveClass('theme-dark')
  await expect.poll(() => pageBackground(page)).toBe(background.dark)
  const switchToLight = page.getByRole('button', toLight)
  await expect(switchToLight.locator('svg')).toHaveAttribute('data-glyph', 'sun')
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('dark')

  await page.reload()
  await expect(page.locator('html')).toHaveClass('theme-dark')
  await expect(switchToLight).toBeVisible()

  await switchToLight.click()
  await expect(page.locator('html')).toHaveClass('theme-light')
  await expect.poll(() => pageBackground(page)).toBe(background.light)
  await expect(page.getByRole('button', toDark)).toBeVisible()
})

test('the theme button works from the keyboard with a visible focus ring', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const button = page.getByRole('button', toDark)
  await expect(button).toBeVisible()
  // Tab from the top of the page until the button has focus: it is a stop in the tab order.
  for (let i = 0; i < 20 && !(await button.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(button).toBeFocused()
  // The global :focus-visible ring (apps/web/src/styles/main.css) shows for keyboard focus.
  await expect(button).toHaveCSS('outline-style', 'solid')

  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveClass('theme-dark')
  const back = page.getByRole('button', toLight)
  await expect(back).toBeFocused()

  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveClass('theme-light')
})

test('with no saved choice the theme follows the operating system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveClass('theme-dark')
  await expect(page.getByRole('button', toLight)).toBeVisible()

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass('theme-light')
  await expect(page.getByRole('button', toDark)).toBeVisible()
})
