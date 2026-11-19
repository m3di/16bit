import { expect, test } from './support/fixtures.ts'

// Keyboard and screen-reader behaviour of the M2 settings components (#114), on the component
// kit. The kit is a dev-only route that needs no data, so nothing is created here. Each test
// works inside the light theme's half of the page.

test.beforeEach(async ({ page }) => {
  await page.goto('/kit')
})

const light = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Light theme' })

test('tabs are one tab stop; arrow keys, Home, and End move and select', async ({ page }) => {
  const kit = light(page)
  const list = kit.getByRole('tablist', { name: 'Attribute settings, light' })
  const general = list.getByRole('tab', { name: 'General' })
  await general.focus()
  await page.keyboard.press('ArrowRight')
  const options = list.getByRole('tab', { name: 'Options' })
  await expect(options).toBeFocused()
  await expect(options).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(list.getByRole('tab', { name: 'Usage' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(general).toBeFocused()
  await expect(general).toHaveAttribute('aria-selected', 'true')
  // Tab leaves the list for the panel, which is named by its tab.
  await page.keyboard.press('Tab')
  await expect(kit.getByRole('tabpanel', { name: 'General' })).toBeFocused()
})

test('a dialog keeps focus inside, closes on Escape, and returns focus', async ({ page }) => {
  const kit = light(page)
  const opener = kit.getByRole('button', { name: 'Open dialog' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'New folder' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused()
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab')
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('a dialog opened by ID shows not found in place of its body', async ({ page }) => {
  await light(page).getByRole('button', { name: 'Dialog not found' }).click()
  const dialog = page.getByRole('dialog', { name: 'Folder' })
  await expect(dialog.getByText('This folder is not available')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('a confirm for something not available shows no form', async ({ page }) => {
  await light(page).getByRole('button', { name: 'Confirm not found' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete hub?' })
  await expect(dialog.getByText('This hub is not available')).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('a plain confirm focuses Cancel first', async ({ page }) => {
  await light(page).getByRole('button', { name: 'Remove Kofi' }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove Kofi from the workspace?' })
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(dialog).toHaveAccessibleDescription(/loses access to every hub/)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('a named confirm waits for the exact name, then reports a failure', async ({ page }) => {
  await light(page).getByRole('button', { name: 'Delete Engineering' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete Engineering?' })
  const name = dialog.getByRole('textbox', { name: 'Type Engineering to confirm' })
  const confirm = dialog.getByRole('button', { name: 'Delete hub' })
  await expect(name).toBeFocused()
  await expect(confirm).toBeDisabled()
  await name.fill('engineering')
  await expect(confirm).toBeDisabled()
  await name.fill('Engineering')
  await expect(confirm).toBeEnabled()
  await page.keyboard.press('Enter')
  // While the action runs, nothing closes the dialog: the reader must see how it ends.
  await expect(dialog.getByRole('button', { name: 'Working' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toContainText('still holds 412 items')
  await expect(dialog).toBeVisible()
})

test('the row menu opens from the keyboard, wraps, and closes back to its button', async ({
  page,
}) => {
  const kit = light(page)
  const button = kit.getByRole('button', { name: 'Actions for Tomas, light' })
  await expect(button).toHaveAttribute('aria-haspopup', 'menu')
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const menu = kit.getByRole('menu', { name: 'Actions for Tomas, light' })
  await expect(menu.getByRole('menuitem', { name: 'Change role' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByRole('menuitem', { name: 'Remove from workspace' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(button).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Resend invite' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(button).toBeFocused()
  await expect(kit.getByText('Chose resend')).toBeVisible()
})

test('a disabled menu item says why and does nothing', async ({ page }) => {
  const kit = light(page)
  await kit.getByRole('button', { name: 'Actions for Tomas, light' }).click()
  const item = kit.getByRole('menuitem', { name: /Make owner/ })
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toHaveAccessibleDescription('Only the owner can do this')
  // Change role, Resend invite, Make owner: Enter on it leaves the menu open.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(item).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(item).toBeVisible()
  await expect(kit.getByText(/^Chose /)).toHaveCount(0)
})

test('the palette is a radio group: arrow keys choose a colour', async ({ page }) => {
  const group = light(page).getByRole('radiogroup', { name: 'Hub colour, light' })
  await expect(group.getByRole('radio')).toHaveCount(16)
  const indigo = group.getByRole('radio', { name: 'Indigo' })
  await expect(indigo).toBeChecked()
  await indigo.focus()
  await page.keyboard.press('ArrowRight')
  await expect(group.getByRole('radio', { name: 'Blue' })).toBeChecked()
  await expect(group.getByRole('radio', { name: 'Blue' })).toBeFocused()
})

test('a toggle is a switch that Space flips', async ({ page }) => {
  const toggle = light(page).getByRole('switch', { name: 'Relations to other hubs, light' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toHaveAccessibleDescription(/Off: items here cannot link/)
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toHaveAccessibleDescription(/On: items here can link/)
})

test('the attribute type picker is a labelled radio group with hints', async ({ page }) => {
  const kit = light(page)
  const group = kit.getByRole('group', { name: 'Type, light' })
  const text = group.getByRole('radio', { name: 'Text', exact: true })
  await expect(text).toHaveAccessibleDescription('A short line of text, such as a title.')
  await text.focus()
  await page.keyboard.press('Space')
  await expect(text).toBeChecked()
  await page.keyboard.press('ArrowDown')
  await expect(group.getByRole('radio', { name: 'Rich text' })).toBeChecked()
})

test('the options editor adds, confirms a used removal, and moves focus on', async ({ page }) => {
  const kit = light(page)
  const list = kit.getByRole('list', { name: 'Stage options, light' })
  await expect(list.getByRole('listitem')).toHaveCount(5)

  // An option with no colour still shows its colour button, as a dashed outline.
  const uncoloured = list.getByRole('button', { name: 'Colour for option 5: No colour' })
  expect(await uncoloured.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')

  await kit.getByRole('button', { name: 'Add option' }).first().click()
  await expect(list.getByRole('textbox', { name: 'Name of option 6' })).toBeFocused()
  await page.keyboard.type('Blocked')

  // Done is unused: it goes at once, and focus moves to the option that took its place.
  await list.getByRole('button', { name: 'Actions for option 4, Done' }).click()
  await kit.getByRole('menuitem', { name: 'Remove option' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(5)
  await expect(list.getByRole('textbox', { name: 'Name of option 4' })).toHaveValue("Won't do")
  await expect(list.getByRole('textbox', { name: 'Name of option 4' })).toBeFocused()

  // Backlog is used by 372 items: removing it asks first (D51).
  await list.getByRole('button', { name: 'Actions for option 1, Backlog' }).click()
  await kit.getByRole('menuitem', { name: 'Remove option' }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove Backlog?' })
  await expect(confirm).toHaveAccessibleDescription(/372 items use this option/)
  await confirm.getByRole('button', { name: 'Remove option' }).click()
  await expect(confirm).toBeHidden()
  await expect(list.getByRole('listitem')).toHaveCount(4)
  // Focus lands on the option that took its place, not on the removed row's menu button.
  await expect(list.getByRole('textbox', { name: 'Name of option 1' })).toBeFocused()

  // The colour opens as a disclosure under its row.
  const colour = list.getByRole('button', { name: /^Colour for option 1:/ })
  await colour.click()
  await expect(colour).toHaveAttribute('aria-expanded', 'true')
  await list
    .getByRole('radiogroup', { name: 'Colour for option 1' })
    .getByRole('radio', { name: 'Red' })
    .check()
  await expect(colour).toHaveAccessibleName('Colour for option 1: Red')
})

test('a static table never selects a row; its controls work by keyboard', async ({ page }) => {
  const table = light(page).getByRole('table', { name: 'People and their roles, light' })
  await expect(table.getByRole('rowheader')).toHaveText(['Priya', 'Kofi', 'Sara'])
  // A click on a cell that holds no control does nothing to the row.
  const kofi = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Kofi' }) })
  await kofi.getByRole('cell', { name: /Engineering/ }).click()
  await expect(table.locator('[aria-selected]')).toHaveCount(0)
  // The role select and the row menu are real controls, reached with Tab.
  const role = table.getByRole('combobox', { name: 'Role for Kofi' })
  await role.focus()
  await page.keyboard.press('Tab')
  const menu = table.getByRole('button', { name: 'Actions for Kofi, light' })
  await expect(menu).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Change role' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeFocused()
  // The read-only row shows its reason and offers no menu.
  const sara = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Sara' }) })
  await expect(sara).toContainText('The only owner')
  await expect(sara.getByRole('button')).toHaveCount(0)
})
