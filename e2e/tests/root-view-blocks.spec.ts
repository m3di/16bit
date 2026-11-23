import { attributeSchema, hubDescriptionSchema, hubListEntrySchema } from '@16bit/core'
import type { APIResponse } from '@playwright/test'
import { expectViewMatches, readBlock } from './support/project.ts'
import {
  expect,
  expectStatus,
  hubPath,
  test,
  uniqueHubName,
  uniquePrefix,
  uniqueTitle,
  type Client,
} from './support/roles.ts'

// One broken block never breaks the page (D18, D79, M4-12 point 5): a block that names an
// attribute removed since the view was saved stays stored and shows "invalid", while the
// blocks next to it keep their data. On a hub of this test's own, since a removed attribute
// can't come back and the seeded hubs are shared.

async function created<T>(res: Promise<APIResponse>, schema: { parse(v: unknown): T }) {
  const r = await res
  await expectStatus(r, 201)
  return schema.parse(await r.json())
}

async function hubVersion(owner: Client, hubId: string) {
  const res = await owner.get(`/hubs/${hubId}`)
  await expectStatus(res, 200)
  return hubDescriptionSchema.parse(await res.json()).hub.version
}

test('removing an attribute a block uses breaks only that block', async ({ as, page }) => {
  const owner = as('owner')
  const hub = await created(
    owner.post('/hubs', {
      name: uniqueHubName('view blocks'),
      color: 'teal',
      idPrefix: uniquePrefix(),
    }),
    hubListEntrySchema,
  )
  const attr = (body: Record<string, unknown>) =>
    created(owner.post(`/hubs/${hub.id}/attributes`, body), attributeSchema)
  const title = await attr({ name: 'Title', type: 'text', config: {} })
  const stage = await attr({
    name: 'Stage',
    type: 'select',
    indexed: true,
    config: {
      options: [
        { id: 'open', label: 'Open', color: 'blue' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  })
  const points = await attr({
    name: 'Points',
    type: 'number',
    indexed: true,
    config: { format: 'plain' },
  })
  await expectStatus(
    await owner.put(`/folders/${hub.id}/attributes`, {
      version: await hubVersion(owner, hub.id),
      attributes: [
        { attributeId: title.id },
        { attributeId: stage.id },
        { attributeId: points.id },
      ],
    }),
    200,
  )
  await expectStatus(
    await owner.patch(`/hubs/${hub.id}`, {
      version: await hubVersion(owner, hub.id),
      titleAttributeId: title.id,
    }),
    200,
  )
  const rows: [string, number][] = [
    ['open', 3],
    ['open', 5],
    ['done', 2],
  ]
  for (const [option, n] of rows) {
    await owner.createItem(hub.id, {
      [title.id]: uniqueTitle('task'),
      [stage.id]: option,
      [points.id]: n,
    })
  }
  const binding = { folderId: hub.id }
  await expectStatus(
    await owner.put(`/folders/${hub.id}/view`, {
      version: 0,
      tree: {
        schemaVersion: 1,
        root: {
          id: 'page',
          type: 'page',
          config: { title: 'Blocks check' },
          children: [
            {
              id: 'points',
              type: 'number',
              config: {
                kind: 'aggregate',
                label: 'Points',
                binding,
                value: { fn: 'sum', attribute: points.id },
              },
            },
            {
              id: 'count',
              type: 'number',
              config: { kind: 'aggregate', label: 'Tasks', binding, value: { fn: 'count' } },
            },
            {
              id: 'by-stage',
              type: 'chart',
              config: {
                kind: 'bars',
                label: 'Tasks by stage',
                binding,
                groupBy: { attribute: stage.id },
                measures: [{ fn: 'count' }],
              },
            },
            {
              id: 'tasks',
              type: 'list',
              config: {
                binding: { ...binding, sort: [{ attribute: stage.id }] },
                fields: [{ attribute: stage.id }],
              },
            },
          ],
        },
      },
    }),
    200,
  )

  await page.goto(hubPath(hub.id))
  await expect(page.getByRole('heading', { level: 1, name: 'Blocks check' })).toBeVisible()
  await expectViewMatches(page, owner, hub.id, { hubId: hub.id })
  expect(await readBlock(page, 'points')).toMatchObject({ number: { value: '10' } })

  // Remove Points, which three items hold (D51 asks for their number).
  await expectStatus(
    await owner.delete(`/attributes/${points.id}?version=${String(points.version)}&confirm=3`),
    204,
  )
  await page.reload()
  const others = ['count', 'by-stage', 'tasks']
  await expect(page.locator('[data-view-block="points"]')).toHaveAttribute(
    'data-block-state',
    'invalid',
  )
  await expect(page.locator('[data-view-block="points"]')).toContainText('Needs fixing')
  await expectViewMatches(page, owner, hub.id, { hubId: hub.id, only: others })
  await expect(page.locator('[data-block-state="error"], [data-block-broken]')).toHaveCount(0)

  // The view stays stored as it was; view data says which block is invalid and why.
  const view = (await (await owner.get(`/folders/${hub.id}/view`)).json()) as { version: number }
  const data = await owner.get(`/folders/${hub.id}/view/data?version=${String(view.version)}`)
  await expectStatus(data, 200)
  const { blocks } = (await data.json()) as { blocks: Record<string, { status: string }> }
  expect(blocks).toMatchObject({
    points: { status: 'invalid' },
    count: { status: 'ok' },
    'by-stage': { status: 'ok' },
    tasks: { status: 'ok' },
  })
})
