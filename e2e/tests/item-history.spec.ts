import { demo, expect, test, uniqueTitle } from './support/fixtures.ts'

const title = demo.hub.titleAttributeId

// The item page's History (issue 198): a cause written through the API (D63) shows with its
// note, its evidence as a safe external link with the host, and the change it follows.
test('a cause written through the API shows in the item history', async ({ api, page }) => {
  const before = uniqueTitle('history before')
  const after = uniqueTitle('history after')
  const created = await api.createItem({ values: { [title]: before } })
  const [createRevision] = await api.revisions(created.id)
  if (!createRevision) throw new Error('The create has no revision')

  await api.parseItem(
    await api.patchItem(created, {
      version: created.version,
      values: { [title]: after },
      cause: {
        note: 'Renamed after the design review',
        evidence: [
          'https://example.com/reviews/42',
          `https://example.org/${'a-long-path-segment/'.repeat(12)}`,
        ],
        causedBy: createRevision.seq,
      },
    }),
  )

  await page.goto(`/w/${demo.workspaceId}/items/${encodeURIComponent(created.id)}`)
  const history = page.getByRole('region', { name: 'History' })
  const update = history.locator('[data-history-entry]').first()

  await expect(update).toContainText('changed')
  await expect(update).toContainText(before)
  await expect(update).toContainText(after)
  await expect(update).toContainText('Renamed after the design review')

  const evidence = update.getByRole('link', { name: /example\.com/ })
  await expect(evidence).toHaveAttribute('href', 'https://example.com/reviews/42')
  await expect(evidence).toHaveAttribute('target', '_blank')
  await expect(evidence).toHaveAttribute('rel', 'noopener noreferrer')

  // The change it follows is the create, on this item: the link moves focus to that entry.
  const follows = update.getByRole('link', { name: `change ${String(createRevision.seq)}` })
  await follows.click()
  const createEntry = history.locator(`#change-${String(createRevision.seq)}`)
  await expect(createEntry).toBeFocused()
  await expect(createEntry).toContainText('created the item')

  // A long evidence URL is cut inside its link; the page never scrolls sideways at phone width.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(update.getByRole('link', { name: /example\.org/ })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
