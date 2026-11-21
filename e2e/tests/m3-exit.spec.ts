import { attributeSchema, hubDescriptionSchema, hubListEntrySchema, type Item } from '@16bit/core'
import type { Page, WebSocketRoute } from '@playwright/test'
import {
  type Client,
  expect,
  expectStatus,
  hubPath,
  itemPanel,
  itemsTable,
  test,
  uniqueHubName,
  uniquePrefix,
  uniqueTitle,
} from './support/roles.ts'

// The M3 exit check (docs/ROADMAP.md, issue 178): two browsers and one agent editing the same
// folder stay consistent. Two browser contexts show one folder while they and an agent key
// create, edit and delete items in it. After every write both browsers show the same rows and
// values as the API, within two seconds (D57 to D60). A dropped feed catches up after the
// reconnect, and a write made over HTTP while the socket is down is confirmed (D59).
//
// Each test makes its own hub, so the rows in view are only its own and nothing else moves
// them. The large-folder half of the exit is large-folder-budgets.spec.ts.

/** How soon after a write both browsers must show it. */
const AGREE_MS = 2_000

// The measured numbers, in the CI log as well as on the report.
// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
test.afterEach(({}, testInfo) => {
  const lines = testInfo.annotations
    .filter((a) => a.description)
    .map((a) => `  ${a.type}: ${a.description ?? ''}`)
  console.log([`[measured] ${testInfo.title}`, ...lines].join('\n'))
})

interface Folder {
  hubId: string
  hubName: string
  prefix: string
  title: string
  points: string
}

async function created<T>(
  res: Promise<import('@playwright/test').APIResponse>,
  schema: { parse(v: unknown): T },
) {
  const r = await res
  await expectStatus(r, 201)
  return schema.parse(await r.json())
}

/** A hub whose root folder shows ID, Title (required, the title attribute) and Points. */
async function buildFolder(owner: Client): Promise<Folder> {
  const hubName = uniqueHubName('m3 exit')
  const prefix = uniquePrefix()
  const hub = await created(
    owner.post('/hubs', { name: hubName, color: 'teal', idPrefix: prefix }),
    hubListEntrySchema,
  )
  const attr = (body: Record<string, unknown>) =>
    created(owner.post(`/hubs/${hub.id}/attributes`, body), attributeSchema)
  const title = await attr({ name: 'Title', type: 'text', config: {} })
  const points = await attr({ name: 'Points', type: 'number', config: { format: 'plain' } })
  const version = async () => {
    const res = await owner.get(`/hubs/${hub.id}`)
    await expectStatus(res, 200)
    return hubDescriptionSchema.parse(await res.json()).hub.version
  }
  await expectStatus(
    await owner.put(`/folders/${hub.id}/attributes`, {
      version: await version(),
      attributes: [{ attributeId: title.id, required: true }, { attributeId: points.id }],
    }),
    200,
  )
  await expectStatus(
    await owner.patch(`/hubs/${hub.id}`, { version: await version(), titleAttributeId: title.id }),
    200,
  )
  return { hubId: hub.id, hubName, prefix, title: title.id, points: points.id }
}

/**
 * Two people, each in their own browser context, invited for this test and made editors of its
 * hub. Their own sessions, not the seeded owner's: the feed allows 10 sockets per session, and
 * the rest of the suite shares the owner's.
 */
async function twoEditors(
  owner: Client,
  f: Folder,
  invite: (role: 'member') => Promise<{ principalId: string; sid: string }>,
  pageWithSession: (sid: string) => Promise<Page>,
): Promise<[Page, Page]> {
  const first = await invite('member')
  const second = await invite('member')
  for (const person of [first, second]) {
    await expectStatus(
      await owner.put(`/hubs/${f.hubId}/grants/${person.principalId}`, { hubRole: 'editor' }),
      200,
    )
  }
  return [await pageWithSession(first.sid), await pageWithSession(second.sid)]
}

interface Row {
  id: string
  seqId: number
  version: number
  values: Record<string, unknown>
}

/** The folder as the API has it, in the table's default order (item number, newest first). */
async function storedItems(client: Client, f: Folder): Promise<Row[]> {
  const res = await client.post('/query', { from: f.hubId, order: 'number', limit: 200 })
  await expectStatus(res, 200)
  return ((await res.json()) as { items: Row[] }).items
}

/** ID, Title and Points of every row, as a person reads them. */
type Shown = [string, string, string][]

async function expected(client: Client, f: Folder): Promise<Shown> {
  return (await storedItems(client, f)).map((item) => {
    const title = item.values[f.title]
    const points = item.values[f.points]
    return [
      `${f.prefix}-${String(item.seqId)}`,
      typeof title === 'string' ? title : '',
      typeof points === 'number' ? String(points) : '',
    ]
  })
}

/** What a browser shows: every body row's first three cells, read in one go. */
function shown(page: Page, f: Folder): Promise<Shown> {
  return itemsTable(page, f.hubName)
    .getByRole('row')
    .evaluateAll((rows) =>
      rows
        .map((row) =>
          [...row.querySelectorAll('td')].slice(0, 3).map((cell) => cell.textContent.trim()),
        )
        .filter((cells) => cells.length > 0),
    ) as Promise<Shown>
}

/**
 * After a write the API has confirmed: every page shows what the API has, within the budget,
 * counted from the call. The time each took is recorded on the test.
 */
async function agree(step: string, pages: Page[], api: Client, f: Folder, budget = AGREE_MS) {
  const start = Date.now()
  const want = await expected(api, f)
  const times = await Promise.all(
    pages.map(async (page, i) => {
      await expect
        .poll(() => shown(page, f), {
          message: `${step}: browser ${String(i + 1)} shows what the API has`,
          timeout: Math.max(1, budget - (Date.now() - start)),
          intervals: [20],
        })
        .toEqual(want)
      return Date.now() - start
    }),
  )
  test.info().annotations.push({ type: 'agreed', description: `${step}: ${times.join(' / ')} ms` })
}

/** Resolves once the page's feed has answered its first subscribe, so it is live. */
function feedLive(page: Page): Promise<void> {
  return new Promise((resolve) => {
    page.on('websocket', (ws) => {
      if (!ws.url().endsWith('/feed')) return
      ws.on('framereceived', (frame) => {
        if (String(frame.payload).includes('"type":"changes"')) resolve()
      })
    })
  })
}

async function openFolder(page: Page, f: Folder, live: Promise<void> = feedLive(page)) {
  await page.goto(hubPath(f.hubId))
  await expect(page.getByRole('heading', { level: 1, name: f.hubName })).toBeVisible()
  await live
}

const label = (f: Folder, item: { seqId: number }) => `${f.prefix}-${String(item.seqId)}`

/** Opens the item in the page's panel from its row. */
async function openInPanel(page: Page, f: Folder, item: { seqId: number }) {
  await itemsTable(page, f.hubName)
    .getByRole('link', { name: label(f, item), exact: true })
    .click()
  await expect(
    itemPanel(page).getByRole('heading', { name: label(f, item), exact: true }),
  ).toBeVisible()
}

/** Types a value into a panel field and saves it with Enter. Resolves with the PATCH status. */
async function editInPanel(page: Page, item: { id: string }, field: string, value: string) {
  const input = itemPanel(page).getByLabel(field)
  await input.fill(value)
  const response = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes(`/items/${item.id}`),
  )
  await input.press('Enter')
  return (await response).status()
}

/** The agent's write needs the current version, as an agent would read it. */
async function current(client: Client, id: string): Promise<Item> {
  const res = await client.get(`/items/${id}`)
  await expectStatus(res, 200)
  return (await res.json()) as Item
}

async function agentPatch(client: Client, id: string, values: Record<string, unknown>) {
  const { version } = await current(client, id)
  await expectStatus(await client.patch(`/items/${id}`, { version, values }), 200)
}

test('two browsers and an agent editing one folder stay consistent', async ({
  as,
  agentKey,
  invite,
  pageWithSession,
}) => {
  test.slow()
  const owner = as('owner')
  // Hubs a spec makes are left in place, like the other role specs' (the agent key fixture
  // revokes its key at the end, which a deleted hub would already have done).
  const f = await buildFolder(owner)
  const { client: agent } = await agentKey({ hubId: f.hubId, hubRole: 'editor' })
  const one = await owner.createItem(f.hubId, { [f.title]: uniqueTitle('one'), [f.points]: 1 })
  const two = await owner.createItem(f.hubId, { [f.title]: uniqueTitle('two'), [f.points]: 2 })
  const three = await owner.createItem(f.hubId, { [f.title]: uniqueTitle('three'), [f.points]: 3 })

  const [a, b] = await twoEditors(owner, f, invite, pageWithSession)
  await Promise.all([openFolder(a, f), openFolder(b, f)])
  await agree('first load', [a, b], owner, f)

  // 1. The agent creates an item.
  const byAgent = await agent.createItem(f.hubId, {
    [f.title]: uniqueTitle('by the agent'),
    [f.points]: 5,
  })
  await agree('agent creates', [a, b], owner, f)

  // 2. Browser A creates one from the New item form, which opens its page. B shows it at
  // once; A shows it on the way back to the folder.
  await a.getByRole('button', { name: 'New item' }).click()
  const form = a.getByRole('complementary', { name: 'New item', exact: true })
  await form.getByLabel('Title (required)').fill(uniqueTitle('by browser A'))
  await form.getByLabel('Points').fill('8')
  const createdByA = a.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/items'),
  )
  await form.getByRole('button', { name: 'Create item' }).click()
  expect((await createdByA).status()).toBe(201)
  await agree('browser A creates', [b], owner, f)
  await expect(a).toHaveURL(/\/items\/[^/?]+$/)
  await a.goBack()
  await agree('browser A back on the folder', [a, b], owner, f)

  // 3. Different items at once: A, B and the agent each edit their own.
  await openInPanel(a, f, one)
  await openInPanel(b, f, two)
  const [statusA, statusB] = await Promise.all([
    editInPanel(a, one, 'Title (required)', uniqueTitle('one edited by A')),
    editInPanel(b, two, 'Points', '21'),
    agentPatch(agent, three.id, { [f.title]: uniqueTitle('three edited by the agent') }),
  ])
  expect([statusA, statusB]).toEqual([200, 200])
  await agree('three writers, three items', [a, b], owner, f)

  // 4. The same item, one writer after another: A, then the agent, then B.
  await openInPanel(a, f, byAgent)
  await openInPanel(b, f, byAgent)
  expect(await editInPanel(a, byAgent, 'Title (required)', uniqueTitle('agent item, A'))).toBe(200)
  await agree('same item: A', [a, b], owner, f)
  await agentPatch(agent, byAgent.id, { [f.points]: 13 })
  await agree('same item: the agent', [a, b], owner, f)
  // B's panel follows both edits, so its own save goes on from the latest version.
  await expect(itemPanel(b).getByLabel('Points')).toHaveValue('13')
  expect(await editInPanel(b, byAgent, 'Title (required)', uniqueTitle('agent item, B'))).toBe(200)
  await agree('same item: B', [a, b], owner, f)
  await expect(itemPanel(a).getByLabel('Points')).toHaveValue('13')

  // 5. A conflicting edit: A and B save the same field from the same version. A's request is
  // slow and reaches the server after B's, so it is refused (409) and A shows B's value.
  await openInPanel(a, f, one)
  await openInPanel(b, f, one)
  const base = (await current(owner, one.id)).version
  await expect(itemPanel(a).locator('[data-item-version]')).toHaveText(String(base))
  await expect(itemPanel(b).locator('[data-item-version]')).toHaveText(String(base))
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let onHeld: () => void = () => undefined
  const isHeld = new Promise<void>((resolve) => {
    onHeld = resolve
  })
  await a.route(`**/items/${one.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      onHeld()
      await held
    }
    await route.continue()
  })
  const fromA = editInPanel(a, one, 'Title (required)', uniqueTitle('conflict, A'))
  // A's request has left the page with the version it had, and waits on the slow network.
  await isHeld
  const winner = uniqueTitle('conflict, B')
  expect(await editInPanel(b, one, 'Title (required)', winner)).toBe(200)
  release()
  expect(await fromA).toBe(409)
  await a.unroute(`**/items/${one.id}`)
  await expect(a.getByRole('alert')).toContainText('was changed by someone else')
  await expect(itemPanel(a).getByLabel('Title (required)')).toHaveValue(winner)
  await agree('conflicting edit', [a, b], owner, f)
  // The agent's stale write is refused too, with the item as it is now.
  const stale = await agent.patch(`/items/${one.id}`, {
    version: base,
    values: { [f.title]: uniqueTitle('conflict, agent') },
  })
  await expectStatus(stale, 409)
  expect(((await stale.json()) as { current: Item }).current.values[f.title]).toBe(winner)
  await agree('agent conflict refused', [a, b], owner, f)

  // 6. Deletes: the agent deletes one item, then A deletes another from its page.
  const doomed = await current(agent, three.id)
  await expectStatus(
    await agent.delete(`/items/${three.id}?version=${String(doomed.version)}`),
    204,
  )
  await agree('agent deletes', [a, b], owner, f)
  await openInPanel(a, f, two)
  await itemPanel(a).getByRole('link', { name: 'Open page' }).click()
  await a.getByRole('button', { name: 'Delete item' }).click()
  const dialog = a.getByRole('dialog', { name: `Delete ${label(f, two)}?` })
  const deleted = a.waitForResponse((r) => r.request().method() === 'DELETE')
  await dialog.getByRole('button', { name: 'Delete item' }).click()
  expect((await deleted).status()).toBe(204)
  await agree('browser A deletes', [b], owner, f)
  await expect(a).toHaveURL(new RegExp(`${hubPath(f.hubId)}$`))
  await agree('browser A back on the folder after its delete', [a, b], owner, f)
})

test('a dropped feed catches up after the reconnect, and a write made while it was down is confirmed', async ({
  as,
  agentKey,
  invite,
  pageWithSession,
}) => {
  test.slow()
  const owner = as('owner')
  // Hubs a spec makes are left in place, like the other role specs' (the agent key fixture
  // revokes its key at the end, which a deleted hub would already have done).
  const f = await buildFolder(owner)
  const { client: agent } = await agentKey({ hubId: f.hubId, hubRole: 'editor' })
  const one = await owner.createItem(f.hubId, { [f.title]: uniqueTitle('one'), [f.points]: 1 })
  const two = await owner.createItem(f.hubId, { [f.title]: uniqueTitle('two'), [f.points]: 2 })

  const [a, b] = await twoEditors(owner, f, invite, pageWithSession)

  // B's feed goes through a route the test can cut. While it is down, every reconnect is
  // closed at once, as when the network or the server is away; HTTP still works.
  let down = false
  let socket: WebSocketRoute | undefined
  let onChanges: () => void = () => undefined
  const bLive = new Promise<void>((resolve) => {
    onChanges = resolve
  })
  await b.routeWebSocket(/\/feed$/, (ws) => {
    if (down) {
      void ws.close({ code: 1011, reason: 'test: connection down' })
      return
    }
    socket = ws
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      server.send(message)
    })
    server.onMessage((message) => {
      ws.send(message)
      if (typeof message === 'string' && message.includes('"type":"changes"')) onChanges()
    })
  })

  await Promise.all([openFolder(a, f), openFolder(b, f, bLive)])
  await agree('first load', [a, b], owner, f)

  // The connection drops.
  const offline = b.getByRole('status').filter({ hasText: 'Offline' })
  await expect(offline).toHaveCount(0)
  down = true
  await socket?.close({ code: 1011, reason: 'test: connection dropped' })
  await expect(offline).toBeVisible()

  // While B is offline: the agent creates and edits, A edits, B edits over HTTP.
  const missed = uniqueTitle('made while B was offline')
  await agent.createItem(f.hubId, { [f.title]: missed, [f.points]: 34 })
  await agentPatch(agent, one.id, { [f.points]: 55 })
  await agree("the agent's writes while B is offline, seen by A", [a], owner, f)
  await openInPanel(a, f, one)
  expect(await editInPanel(a, one, 'Title (required)', uniqueTitle('one, A while B offline'))).toBe(
    200,
  )
  await agree("A's write while B is offline", [a], owner, f)

  // B's own write goes over HTTP and is confirmed by its response, socket or not (D59).
  await openInPanel(b, f, two)
  const mine = uniqueTitle('two, B while offline')
  expect(await editInPanel(b, two, 'Title (required)', mine)).toBe(200)
  await expect(itemPanel(b).locator('[data-item-version]')).toHaveText('2')
  await expect(itemPanel(b).getByLabel('Title (required)')).toHaveValue(mine)
  await expect(b.getByRole('alert')).toHaveCount(0)
  expect((await current(owner, two.id)).values[f.title]).toBe(mine)
  await agree("B's write while offline, seen by A", [a], owner, f)
  // B really was cut off: what the others did has not reached it.
  await expect(itemsTable(b, f.hubName).getByRole('row').filter({ hasText: missed })).toHaveCount(0)
  await expect(offline).toBeVisible()

  // The connection comes back. B reconnects on its own, catches up and agrees with A.
  down = false
  const back = Date.now()
  await expect(offline).toHaveCount(0, { timeout: 20_000 })
  test
    .info()
    .annotations.push({ type: 'reconnected', description: `${String(Date.now() - back)} ms` })
  await agree('after the reconnect', [a, b], owner, f)
  // And it is live again.
  await agentPatch(agent, two.id, { [f.points]: 89 })
  await agree('live again after the reconnect', [a, b], owner, f)
})
