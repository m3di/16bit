import { demo, expect, test, uniqueTitle } from './support/fixtures.ts'

const title = demo.hub.titleAttributeId

test('a patch with a stale version returns 409 with the current item', async ({ api }) => {
  const created = await api.createItem({ values: { [title]: uniqueTitle('conflict') } })
  expect(created.version).toBe(1)

  // Another writer gets there first.
  const updated = await api.parseItem(
    await api.patchItem(created, {
      version: 1,
      values: { [title]: 'Changed by the first writer' },
    }),
  )
  expect(updated.version).toBe(2)

  // The second writer still holds version 1.
  const conflict = await api.parseConflict(
    await api.patchItem(created, {
      version: 1,
      values: { [title]: 'Changed by the second writer' },
    }),
  )
  expect(conflict.error).toBe('conflict')
  expect(conflict.current).toMatchObject({
    id: created.id,
    version: 2,
    values: { [title]: 'Changed by the first writer' },
  })

  // The rejected write left nothing behind.
  const stored = await api.getItem(created.id)
  expect(stored.version).toBe(2)
  expect(stored.values[title]).toBe('Changed by the first writer')
})

test('a patch with a version ahead of the item also returns 409', async ({ api }) => {
  const created = await api.createItem({ values: { [title]: uniqueTitle('ahead') } })

  const conflict = await api.parseConflict(
    await api.patchItem(created, { version: 5, values: { [title]: 'From the future' } }),
  )
  expect(conflict.current).toMatchObject({ id: created.id, version: 1 })
})
