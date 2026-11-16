import { demo, expect, test } from './support/fixtures.ts'

// Seeded by `pnpm seed`. Counts are not checked: other specs add items in parallel.
const seeded = [
  { workspace: demo.workspaceName, hubs: ['Archive', 'Design', 'Hiring', 'Product', 'Support'] },
  { workspace: 'Acme Studio', hubs: ['Operations'] },
]

test('the dashboard shows the seeded workspaces and their hubs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible()

  for (const { workspace, hubs } of seeded) {
    const section = page.getByRole('region', { name: workspace })
    await expect(section.getByRole('heading', { level: 2, name: workspace })).toBeVisible()
    for (const hub of hubs) {
      await expect(section.getByRole('listitem').filter({ hasText: hub })).toBeVisible()
    }
  }
})

test('each hub card shows an item count', async ({ page }) => {
  await page.goto('/')
  const card = page
    .getByRole('region', { name: demo.workspaceName })
    .getByRole('listitem')
    .filter({ hasText: 'Hiring' })
  await expect(card).toContainText(/\d[\d,]* items?/)
})
