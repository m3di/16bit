import type { Page } from '@playwright/test'
import { parseItemRead } from './support/item-responses.ts'
import { demo } from './support/fixtures.ts'
import {
  type Client,
  expect,
  expectStatus,
  type Invited,
  test,
  uniqueTitle,
} from './support/roles.ts'

// Live sync (D57 to D60, issue 175): two browser contexts on the same folder. An edit in one
// shows up in the other over the feed, without a reload.
//
// Each browser is a person invited for the test, with their own session and a grant on the hub,
// not the seeded owner: the feed allows 10 sockets per session (#171), and the rest of the suite
// shares the owner's.

const title = demo.hub.titleAttributeId
const hubPath = `/w/${demo.workspaceId}/hubs/${demo.hub.id}`

const table = (page: Page) => page.getByRole('table', { name: `Items in ${demo.hub.name}` })
const panel = (page: Page) => page.getByRole('complementary', { name: 'Item', exact: true })

/** Someone new, with `hubRole` on the hub, in a browser context of their own. */
async function personOn(
  hubId: string,
  hubRole: 'editor' | 'viewer',
  owner: Client,
  invite: (role: 'member') => Promise<Invited>,
  pageWithSession: (sid: string) => Promise<Page>,
): Promise<{ page: Page; name: string }> {
  const person = await invite('member')
  await expectStatus(
    await owner.put(`/hubs/${hubId}/grants/${person.principalId}`, { hubRole }),
    200,
  )
  return { page: await pageWithSession(person.sid), name: person.name }
}

async function getItem(owner: Client, id: string) {
  const res = await owner.get(`/items/${id}`)
  await expectStatus(res, 200)
  return parseItemRead(await res.json())
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

test('an edit in one browser shows up in another without a reload', async ({
  as,
  invite,
  pageWithSession,
}) => {
  const owner = as('owner')
  const before = uniqueTitle('live before')
  const after = uniqueTitle('live after')
  const item = await owner.createItem(demo.hub.id, { [title]: before })
  const { page: a } = await personOn(demo.hub.id, 'editor', owner, invite, pageWithSession)
  const { page: b } = await personOn(demo.hub.id, 'viewer', owner, invite, pageWithSession)

  // The reader's feed, live before the edit is made.
  const live = feedLive(b)
  await b.goto(hubPath)
  await expect(table(b).getByRole('row').filter({ hasText: before })).toBeVisible()
  await live
  let reloaded = false
  b.on('framenavigated', () => {
    reloaded = true
  })

  await a.goto(`${hubPath}?item=${item.id}`)
  const field = panel(a).getByLabel('Title (required)')
  await expect(field).toHaveValue(before)
  await field.fill(after)
  await field.press('Enter')
  await expect(panel(a).locator('[data-item-version]')).toHaveText('2')

  await expect(table(b).getByRole('row').filter({ hasText: after })).toBeVisible()
  await expect(table(b).getByRole('row').filter({ hasText: before })).toHaveCount(0)
  expect(reloaded).toBe(false)
  await expect(b.locator('[data-connection]')).not.toContainText('Offline')
})

test('a draft being typed is kept when someone else saves, and the conflict offers both', async ({
  as,
  invite,
  pageWithSession,
}) => {
  const owner = as('owner')
  const item = await owner.createItem(demo.hub.id, { [title]: uniqueTitle('draft before') })
  const theirs = uniqueTitle('draft theirs')
  const mine = uniqueTitle('draft mine')
  const { page: a } = await personOn(demo.hub.id, 'editor', owner, invite, pageWithSession)
  const { page: b, name: otherName } = await personOn(
    demo.hub.id,
    'editor',
    owner,
    invite,
    pageWithSession,
  )

  // The typist's feed is live before anything is saved.
  const live = feedLive(a)
  await a.goto(`${hubPath}?item=${item.id}`)
  await live
  const field = panel(a).getByLabel('Title (required)')
  await expect(field).toHaveValue(item.values[title] as string)
  await field.fill(mine)

  // Someone else saves the same field.
  await b.goto(`${hubPath}?item=${item.id}`)
  const theirField = panel(b).getByLabel('Title (required)')
  await theirField.fill(theirs)
  await theirField.press('Enter')
  await expect(panel(b).locator('[data-item-version]')).toHaveText('2')

  // The typist keeps the draft and is told, with the new value.
  const note = panel(a).locator('[data-changed-while-editing]')
  await expect(note.getByRole('status')).toContainText(
    `Changed by ${otherName} while you were editing: “${theirs}”`,
  )
  await expect(field).toHaveValue(mine)

  // Saving meets the conflict: theirs is shown, and the draft is offered back.
  await field.press('Enter')
  const offer = panel(a).locator('[data-refused-draft]')
  await expect(offer).toContainText(`“${mine}” was not saved`)
  await expect(field).toHaveValue(theirs)
  expect((await getItem(owner, item.id)).values[title]).toBe(theirs)

  await offer.getByRole('button', { name: 'Keep mine' }).click()
  await expect(panel(a).locator('[data-item-version]')).toHaveText('3')
  await expect(field).toHaveValue(mine)
  await expect(offer).toHaveCount(0)
  expect(await getItem(owner, item.id)).toMatchObject({ version: 3, values: { [title]: mine } })
})

test('a rich text draft is kept when someone else saves, and the conflict offers both', async ({
  as,
  invite,
  pageWithSession,
}) => {
  // Launch is the seeded hub with a rich text field (Notes).
  const launchPath = `/w/${demo.workspaceId}/hubs/launch`
  const notesId = 'launch-notes'
  const doc = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  const owner = as('owner')
  const item = await owner.createItem('launch', {
    'launch-title': uniqueTitle('rich draft'),
    [notesId]: doc('Notes before'),
  })
  const theirs = uniqueTitle('notes theirs')
  const mine = uniqueTitle('notes mine')
  const { page: a } = await personOn('launch', 'editor', owner, invite, pageWithSession)
  const { page: b, name: otherName } = await personOn(
    'launch',
    'editor',
    owner,
    invite,
    pageWithSession,
  )
  /** Replaces the document in a page's Notes editor, and leaves the editor focused. */
  async function write(page: Page, text: string) {
    const notes = panel(page).getByRole('textbox', { name: 'Notes' })
    await notes.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(text)
    await expect(notes).toHaveText(text)
    return notes
  }

  const live = feedLive(a)
  await a.goto(`${launchPath}?item=${item.id}`)
  await live
  const notes = await write(a, mine)

  // Someone else saves the same field; their editor saves when it loses focus.
  await b.goto(`${launchPath}?item=${item.id}`)
  await write(b, theirs)
  await panel(b).getByLabel('Title (required)').focus()
  await expect(panel(b).locator('[data-item-version]')).toHaveText('2')

  // The writer keeps the draft and is told, with the new text.
  const note = panel(a).locator('[data-changed-while-editing]')
  await expect(note.getByRole('status')).toContainText(
    `Changed by ${otherName} while you were editing: “${theirs}”`,
  )
  await expect(notes).toHaveText(mine)

  // Leaving the editor saves against the version the draft was based on: the conflict shows
  // theirs and offers the draft back.
  await panel(a).getByLabel('Title (required)').focus()
  const offer = panel(a).locator('[data-refused-draft]')
  await expect(offer).toContainText(`your Notes “${mine}” was not saved`)
  await expect(notes).toHaveText(theirs)
  expect((await getItem(owner, item.id)).values[notesId]).toEqual(doc(theirs))

  await offer.getByRole('button', { name: 'Keep mine' }).click()
  await expect(panel(a).locator('[data-item-version]')).toHaveText('3')
  await expect(notes).toHaveText(mine)
  await expect(offer).toHaveCount(0)
  expect(await getItem(owner, item.id)).toMatchObject({
    version: 3,
    values: { [notesId]: doc(mine) },
  })
})

test('a live create puts the item first and keeps focus on the row the reader left (D61)', async ({
  as,
  invite,
  pageWithSession,
}) => {
  // Product's own items (about 300) are enough to scroll a row far out of view, so this test
  // adds only its one item, and does not crowd the Design hub the other specs here watch.
  const owner = as('owner')
  const productPath = `/w/${demo.workspaceId}/hubs/product`
  const products = (page: Page) => page.getByRole('table', { name: 'Items in Product' })
  const { page } = await personOn('product', 'viewer', owner, invite, pageWithSession)
  const rowCount = async () =>
    Number((await products(page).getAttribute('aria-rowcount')) ?? '1') - 1
  const live = feedLive(page)
  await page.goto(productPath)
  await expect(products(page).locator('tbody tr[data-row]').first()).toBeVisible()
  await live

  // The reader moves to the second row by keyboard, then scrolls it far out of view.
  await products(page).locator('tbody tr[data-index="0"]').focus()
  await page.keyboard.press('ArrowDown')
  const second = products(page).locator('tbody tr[data-index="1"]')
  await expect(second).toBeFocused()
  const id = await second.getByRole('link').innerText()
  await page.locator('[data-virtual]').evaluate((el) => {
    el.scrollTop = 100 * 38
  })
  const before = await rowCount()

  // Someone else creates an item: it goes first, and every row moves down one. Other specs
  // may add to Product meanwhile, so the row is found by its ID, not by a fixed index.
  const fresh = uniqueTitle('live create')
  await owner.createItem('product', { 'product-title': fresh })
  await expect.poll(rowCount).toBeGreaterThan(before)
  const focused = products(page).locator('tbody tr:focus')
  await expect(focused.getByRole('link')).toHaveText(id)
  expect(Number(await focused.getAttribute('data-index'))).toBeGreaterThan(1)

  await page.locator('[data-virtual]').evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(products(page).getByRole('row').filter({ hasText: fresh })).toBeVisible()
})
