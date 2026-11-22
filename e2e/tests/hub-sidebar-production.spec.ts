import { folderSchema, hubDescriptionSchema, hubListEntrySchema } from '@16bit/core'
import type { Page } from '@playwright/test'
import {
  expect,
  expectStatus,
  hubPath,
  test,
  uniqueHubName,
  uniquePrefix,
} from './support/roles.ts'

// The sidebar's folder menus on the production build (issue 233). In the built app a template
// ref named like an import (`ref="folderActions"` beside `import { folderActions }`) was compiled
// as a function ref: every render called the import with the dialog component, which threw, and
// no menu entry did anything. The dev server compiles templates apart, so hub-sidebar.spec.ts
// passed there. This runs one write and one dialog from the menu against the build.

function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Folders' })
}

test('the sidebar menu entries open their dialogs and save on the production build', async ({
  page,
  as,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const owner = as('owner')
  const created = await owner.post('/hubs', {
    name: uniqueHubName('sidebar built'),
    color: 'teal',
    idPrefix: uniquePrefix(),
  })
  await expectStatus(created, 201)
  const hub = hubListEntrySchema.parse(await created.json())
  const folderRes = await owner.post(`/hubs/${hub.id}/folders`, {
    parentId: hub.id,
    name: 'Backlog',
    color: 'blue',
  })
  await expectStatus(folderRes, 201)
  const backlog = folderSchema.parse(await folderRes.json())

  await page.goto(hubPath(hub.id))
  await sidebar(page).getByRole('button', { name: 'Actions for Backlog', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename, recolour or move' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Backlog' })
  await dialog.getByLabel('Name').fill('Queue')
  await dialog.getByRole('button', { name: 'Save folder' }).click()
  await expect(dialog).toBeHidden()
  await expect(sidebar(page).getByRole('link', { name: /^Queue/ })).toBeVisible()
  const res = await owner.get(`/hubs/${hub.id}`)
  await expectStatus(res, 200)
  const d = hubDescriptionSchema.parse(await res.json())
  expect(d.folders.find((f) => f.id === backlog.id)?.name).toBe('Queue')

  // The root's entries open their dialogs too.
  await sidebar(page)
    .getByRole('button', { name: `Actions for ${hub.name}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Attributes' }).click()
  const attributes = page.getByRole('dialog', { name: `Attributes in ${hub.name}` })
  await expect(attributes).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(attributes).toBeHidden()

  expect(errors).toEqual([])
})
