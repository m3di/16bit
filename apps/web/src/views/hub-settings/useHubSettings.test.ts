import type { Attribute, Folder } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { fakeApi, json, type Call } from '../hub/fixtures.test-utils.ts'
import { description, HUB, WS } from './fixtures.test-utils.ts'
import { useHubSettings } from './useHubSettings.ts'

const base = `/v1/workspaces/${WS}`
type Handler = (call: Call) => Response

/** A settings store over a fake API. GET of the hub always answers; `routes` add the rest. */
async function setup(routes: Record<string, Handler> = {}) {
  const { fetchFn, calls } = fakeApi((call) => {
    const route = routes[`${call.method} ${call.path}`]
    if (route) return route(call)
    if (call.method === 'GET' && call.path === `${base}/hubs/${HUB}`) return json(description())
    return json({ error: 'not_found', message: 'Route not found' }, 404)
  })
  const model = useHubSettings(WS, HUB, fetchFn)
  await model.load()
  const data = () => {
    if (model.hub.value.state !== 'ready') throw new Error('not ready')
    return model.hub.value.data
  }
  const folder = (id: string) => {
    const f = id === HUB ? data().hub : data().folders.find((x) => x.id === id)
    if (!f) throw new Error(`no folder ${id}`)
    return f
  }
  const attribute = (id: string) => {
    const a = data().attributes.find((x) => x.id === id)
    if (!a) throw new Error(`no attribute ${id}`)
    return a
  }
  const writes = () => calls.filter((c) => c.method !== 'GET')
  return { model, calls, writes, data, folder, attribute }
}

const conflict = (current: unknown) =>
  json({ error: 'conflict', message: 'Stale version', current }, 409)
const confirmRequired = (affected: number) =>
  json({ error: 'confirm_required', message: 'Items hold values', affected }, 409)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('loading', () => {
  it('reads the hub, and keeps a 404 apart from other errors', async () => {
    const { model } = await setup()
    expect(model.hub.value.state).toBe('ready')

    const { fetchFn } = fakeApi(() => json({ error: 'not_found', message: 'Hub not found' }, 404))
    const hidden = useHubSettings(WS, 'other', fetchFn)
    await hidden.load()
    expect(hidden.hub.value.state === 'error' && hidden.hub.value.error.isNotFound).toBe(true)
  })

  it('offers only hubs the reader holds a grant on as relation targets', async () => {
    const hub = (id: string, access: 'granted' | 'none') =>
      access === 'granted'
        ? { ...description().folders[0], id, hubId: id, parentId: null, access, hubRole: 'viewer' }
        : { workspaceId: WS, id, name: id, color: 'red', access }
    const { model } = await setup({
      [`GET ${base}/hubs?limit=200`]: () =>
        json({ items: [hub('ops', 'granted'), hub('secret', 'none')], nextCursor: null }),
    })
    await model.loadTargets()
    const t = model.targets.value
    expect(t.state === 'ready' && t.data.map((h) => h.id)).toEqual(['ops'])
  })
})

describe('folders', () => {
  it('creates a folder and lists it', async () => {
    const created: Folder = {
      workspaceId: WS,
      id: 'f-new',
      hubId: HUB,
      parentId: HUB,
      name: 'Epics',
      color: 'pink',
      idPrefix: 'BLD',
      itemCount: 0,
      version: 0,
    }
    const { model, writes, data } = await setup({
      [`POST ${base}/hubs/${HUB}/folders`]: () => json(created, 201),
    })
    const result = await model.createFolder({ parentId: HUB, name: 'Epics', color: 'pink' })
    expect(result.ok).toBe(true)
    expect(writes()[0]?.body).toEqual({ parentId: HUB, name: 'Epics', color: 'pink' })
    expect(data().folders.map((f) => f.name)).toContain('Epics')
  })

  it('renames and moves with the version it saw', async () => {
    const { model, writes, folder } = await setup({
      [`PATCH ${base}/folders/sprint-1`]: (call) =>
        json({ ...description().folders[2], ...(call.body as object), version: 3 }),
    })
    const result = await model.updateFolder(folder('sprint-1'), {
      name: 'Sprint one',
      parentId: HUB,
    })
    expect(result.ok).toBe(true)
    expect(writes()[0]?.body).toEqual({ version: 2, name: 'Sprint one', parentId: HUB })
    expect(folder('sprint-1')).toMatchObject({ name: 'Sprint one', parentId: HUB, version: 3 })
  })

  it('on a version conflict shows the server version and says the change was not saved', async () => {
    const theirs = { ...description().folders[1], name: 'Iterations', version: 7 }
    const { model, folder } = await setup({
      [`PATCH ${base}/folders/sprints`]: () => conflict(theirs),
    })
    const result = await model.updateFolder(folder('sprints'), { name: 'Cycles' })
    expect(result).toMatchObject({ ok: false, kind: 'conflict' })
    expect(!result.ok && result.kind === 'conflict' && result.message).toMatch(/not saved/)
    expect(folder('sprints')).toMatchObject({ name: 'Iterations', version: 7 })
  })

  it('refuses a move into its own subfolder with the server message (400)', async () => {
    const { model, folder } = await setup({
      [`PATCH ${base}/folders/sprints`]: () =>
        json(
          {
            error: 'invalid_request',
            message: 'parentId: a folder cannot move into itself or one of its subfolders',
          },
          400,
        ),
    })
    const result = await model.updateFolder(folder('sprints'), { parentId: 'sprint-1' })
    expect(result).toMatchObject({ ok: false, kind: 'refused' })
    expect(!result.ok && result.kind === 'refused' && result.message).toMatch(/subfolders/)
    expect(folder('sprints').parentId).toBe(HUB)
  })

  it('deletes an empty folder with its version in the query', async () => {
    const { model, writes, data, folder } = await setup({
      [`DELETE ${base}/folders/sprint-1?version=2`]: () => new Response(null, { status: 204 }),
    })
    const result = await model.deleteFolder(folder('sprint-1'))
    expect(result.ok).toBe(true)
    expect(writes()[0]?.path).toBe(`${base}/folders/sprint-1?version=2`)
    expect(data().folders.map((f) => f.id)).not.toContain('sprint-1')
  })

  it('keeps a folder the server refuses to delete (not_empty) and says why', async () => {
    const { model, data, folder } = await setup({
      [`DELETE ${base}/folders/sprints?version=2`]: () =>
        json({ error: 'not_empty', message: 'The folder still holds folders or items' }, 409),
    })
    const result = await model.deleteFolder(folder('sprints'))
    expect(result).toMatchObject({ ok: false, kind: 'refused' })
    expect(!result.ok && result.kind === 'refused' && result.message).toMatch(/still holds/)
    expect(data().folders.map((f) => f.id)).toContain('sprints')
  })

  it('a 403 says only hub admins change folders', async () => {
    const { model, folder } = await setup({
      [`PATCH ${base}/folders/sprints`]: () =>
        json({ error: 'forbidden', message: 'Forbidden' }, 403),
    })
    const result = await model.updateFolder(folder('sprints'), { name: 'X' })
    expect(!result.ok && result.kind === 'refused' && result.message).toBe(
      'Only hub admins can change folders and attributes.',
    )
  })

  it('a 404 reads the hub again, since the folder is gone', async () => {
    const { model, calls, folder } = await setup({
      [`PATCH ${base}/folders/sprints`]: () =>
        json({ error: 'not_found', message: 'Folder not found' }, 404),
    })
    const before = calls.filter((c) => c.method === 'GET').length
    const result = await model.updateFolder(folder('sprints'), { name: 'X' })
    await flush()
    expect(!result.ok && result.kind === 'refused' && result.message).toMatch(/no longer available/)
    expect(calls.filter((c) => c.method === 'GET').length).toBe(before + 1)
  })
})

describe("a folder's attributes", () => {
  const answer = (call: Call, requiredEmpty: { attributeId: string; items: number }[]) => {
    const body = call.body as { attributes: { attributeId: string; required: boolean }[] }
    const saved = !(call.body as { dryRun: boolean }).dryRun
    return json({
      folder: { ...description().folders[0], version: saved ? 3 : 2 },
      attributes: body.attributes.map((a, position) => ({
        workspaceId: WS,
        hubId: HUB,
        folderId: 'backlog',
        position,
        ...a,
      })),
      requiredEmpty,
    })
  }

  it('a dry run returns the empty counts and changes nothing on the page (D51)', async () => {
    const { model, writes, data, folder } = await setup({
      [`PUT ${base}/folders/backlog/attributes`]: (call) =>
        answer(call, [
          { attributeId: 'title', items: 0 },
          { attributeId: 'points', items: 3 },
        ]),
    })
    const list = [
      { attributeId: 'title', required: true },
      { attributeId: 'points', required: true },
    ]
    const result = await model.setFolderAttributes(folder('backlog'), list, true)
    expect(writes()[0]?.body).toEqual({ version: 2, dryRun: true, attributes: list })
    expect(result.ok && result.data.requiredEmpty).toEqual([
      { attributeId: 'title', items: 0 },
      { attributeId: 'points', items: 3 },
    ])
    expect(data().folderAttributes.filter((fa) => fa.folderId === 'backlog')).toHaveLength(2)
    expect(folder('backlog').version).toBe(2)
  })

  it('saving replaces the list, in order, and moves the version', async () => {
    const { model, data, folder } = await setup({
      [`PUT ${base}/folders/backlog/attributes`]: (call) => answer(call, []),
    })
    const list = [
      { attributeId: 'stage', required: false },
      { attributeId: 'points', required: false },
    ]
    const result = await model.setFolderAttributes(folder('backlog'), list, false)
    expect(result.ok).toBe(true)
    const shown = data()
      .folderAttributes.filter((fa) => fa.folderId === 'backlog')
      .sort((a, b) => a.position - b.position)
      .map((fa) => fa.attributeId)
    expect(shown).toEqual(['stage', 'points'])
    expect(folder('backlog').version).toBe(3)
  })

  it('the hub itself is set through its own ID and keeps its title attribute', async () => {
    // The answer is the hub as a plain folder, without `titleAttributeId`.
    const hubAsFolder: Record<string, unknown> = { ...description().hub }
    delete hubAsFolder['titleAttributeId']
    const { model, data, folder } = await setup({
      [`PUT ${base}/folders/${HUB}/attributes`]: () =>
        json({ folder: { ...hubAsFolder, version: 3 }, attributes: [], requiredEmpty: [] }),
    })
    const result = await model.setFolderAttributes(folder(HUB), [], false)
    expect(result.ok).toBe(true)
    expect(data().hub.titleAttributeId).toBe('title')
    expect(data().hub.version).toBe(3)
  })

  it('on a conflict shows the current list and says the change was not saved', async () => {
    const current = {
      folder: { ...description().folders[0], version: 9 },
      attributes: [
        {
          workspaceId: WS,
          hubId: HUB,
          folderId: 'backlog',
          attributeId: 'points',
          position: 0,
          required: true,
        },
      ],
    }
    const { model, data, folder } = await setup({
      [`PUT ${base}/folders/backlog/attributes`]: () => conflict(current),
    })
    const result = await model.setFolderAttributes(folder('backlog'), [], false)
    expect(result).toMatchObject({ ok: false, kind: 'conflict' })
    expect(folder('backlog').version).toBe(9)
    expect(
      data()
        .folderAttributes.filter((fa) => fa.folderId === 'backlog')
        .map((fa) => fa.attributeId),
    ).toEqual(['points'])
  })
})

describe('attributes', () => {
  it('creates an attribute', async () => {
    const created: Attribute = {
      workspaceId: WS,
      id: 'a-due',
      hubId: HUB,
      name: 'Due',
      indexed: true,
      version: 0,
      type: 'date',
      config: { includeTime: false },
    }
    const { model, data } = await setup({
      [`POST ${base}/hubs/${HUB}/attributes`]: () => json(created, 201),
    })
    const result = await model.createAttribute({
      name: 'Due',
      type: 'date',
      indexed: true,
      config: { includeTime: false },
    })
    expect(result.ok).toBe(true)
    expect(data().attributes.map((a) => a.id)).toContain('a-due')
  })

  it('removing an option that items hold asks with the count, then resends with it (D51)', async () => {
    const options = [{ id: 'todo', label: 'To do', color: 'grey' as const }]
    const { model, writes, attribute } = await setup({
      [`PATCH ${base}/attributes/stage`]: (call) =>
        (call.body as { confirm?: number }).confirm === 12
          ? json({ ...attribute('stage'), config: { options }, version: 4 })
          : confirmRequired(12),
    })
    const first = await model.updateAttribute(attribute('stage'), { options })
    expect(first).toEqual({ ok: false, kind: 'confirm', affected: 12 })
    expect(attribute('stage').version).toBe(3)

    const second = await model.updateAttribute(attribute('stage'), { options }, 12)
    expect(second.ok).toBe(true)
    expect(writes().map((c) => c.body)).toEqual([
      { version: 3, options },
      { version: 3, options, confirm: 12 },
    ])
    expect(attribute('stage').version).toBe(4)
  })

  it('a renamed attribute conflict shows their version', async () => {
    const { model, attribute } = await setup({
      [`PATCH ${base}/attributes/points`]: () =>
        conflict({ ...attribute('points'), name: 'Estimate', version: 5 }),
    })
    const result = await model.updateAttribute(attribute('points'), { name: 'Size' })
    expect(result).toMatchObject({ ok: false, kind: 'conflict' })
    expect(attribute('points')).toMatchObject({ name: 'Estimate', version: 5 })
  })

  it('deleting an attribute items hold asks first, then sends confirm in the query', async () => {
    const { model, writes, data, attribute } = await setup({
      [`DELETE ${base}/attributes/title?version=0`]: () => confirmRequired(4),
      [`DELETE ${base}/attributes/title?version=0&confirm=4`]: () =>
        new Response(null, { status: 204 }),
    })
    const first = await model.deleteAttribute(attribute('title'))
    expect(first).toEqual({ ok: false, kind: 'confirm', affected: 4 })
    expect(data().attributes.map((a) => a.id)).toContain('title')

    const second = await model.deleteAttribute(attribute('title'), 4)
    expect(second.ok).toBe(true)
    expect(writes().map((c) => c.path)).toEqual([
      `${base}/attributes/title?version=0`,
      `${base}/attributes/title?version=0&confirm=4`,
    ])
    // It leaves every folder, and it was the title attribute, so the hub has none now (D50).
    expect(data().attributes.map((a) => a.id)).not.toContain('title')
    expect(data().folderAttributes.some((fa) => fa.attributeId === 'title')).toBe(false)
    expect(data().hub.titleAttributeId).toBeNull()
  })

  it('reads the hub again after deleting, since detaching moved folder versions', async () => {
    const { model, calls, attribute } = await setup({
      [`DELETE ${base}/attributes/points?version=1`]: () => new Response(null, { status: 204 }),
    })
    await model.deleteAttribute(attribute('points'))
    await flush()
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })
})

describe('the hub itself (general settings)', () => {
  const hubPath = `${base}/hubs/${HUB}`
  const saved = (body: Record<string, unknown>) => ({
    ...description().hub,
    ...body,
    version: Number(body['version']) + 1,
  })

  it('shows a rename at once and sends it with the version', async () => {
    const { model, writes, data } = await setup({
      [`PATCH ${hubPath}`]: (call) => json(saved(call.body as Record<string, unknown>)),
    })
    const done = model.updateHub({ name: 'Platform' })
    expect(data().hub.name).toBe('Platform')
    expect(model.hubSaving.value).toBe(1)
    const result = await done
    expect(result.ok).toBe(true)
    expect(writes()).toEqual([
      { method: 'PATCH', path: hubPath, body: { version: 2, name: 'Platform' } },
    ])
    expect(data().hub).toMatchObject({ name: 'Platform', version: 3 })
    expect(model.hubSaving.value).toBe(0)
  })

  it('sends changes one at a time, each with the version the last answer left', async () => {
    const { model, writes, data } = await setup({
      [`PATCH ${hubPath}`]: (call) => json(saved(call.body as Record<string, unknown>)),
    })
    await Promise.all([
      model.updateHub({ color: 'red' }),
      model.updateHub({ titleAttributeId: null }),
    ])
    expect(writes().map((w) => w.body)).toEqual([
      { version: 2, color: 'red' },
      { version: 3, titleAttributeId: null },
    ])
    expect(data().hub).toMatchObject({ color: 'red', titleAttributeId: null, version: 4 })
  })

  it('puts the saved value back and says why when the API refuses', async () => {
    const { model, data } = await setup({
      [`PATCH ${hubPath}`]: () =>
        json({ error: 'invalid_request', message: 'Not a text attribute' }, 400),
    })
    const result = await model.updateHub({ titleAttributeId: 'stage' })
    expect(result).toMatchObject({ ok: false, kind: 'refused' })
    expect(data().hub.titleAttributeId).toBe('title')
    expect(model.hubNotice.value).toBe('Your change was not saved. Not a text attribute')
  })

  it('keeps a newer choice when an older change to the same field is refused', async () => {
    let n = 0
    const { model, data } = await setup({
      [`PATCH ${hubPath}`]: (call) =>
        ++n === 1
          ? json({ error: 'internal', message: 'Boom' }, 500)
          : json(saved(call.body as Record<string, unknown>)),
    })
    const first = model.updateHub({ name: 'One' })
    const second = model.updateHub({ name: 'Two' })
    await first
    // The refused first change does not undo the second, which is still on its way.
    expect(data().hub.name).toBe('Two')
    await second
    expect(data().hub.name).toBe('Two')
  })

  it('a 403 rolls back with the reason and reads the hub again', async () => {
    const { model, data, calls } = await setup({
      [`PATCH ${hubPath}`]: () => json({ error: 'forbidden', message: 'No' }, 403),
    })
    await model.updateHub({ name: 'Mine' })
    expect(data().hub.name).toBe('Build')
    expect(model.hubNotice.value).toBe(
      'Only hub admins can change this hub. Your change was not saved.',
    )
    await flush()
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })

  it('a conflict shows the server hub and drops the changes queued behind it', async () => {
    const theirs = { ...description().hub, name: 'Theirs', color: 'pink', version: 7 }
    const { model, writes, data } = await setup({
      [`PATCH ${hubPath}`]: () => conflict(theirs),
    })
    const [first, second] = await Promise.all([
      model.updateHub({ name: 'Mine' }),
      model.updateHub({ color: 'red' }),
    ])
    expect(first).toMatchObject({ ok: false, kind: 'conflict' })
    expect(second).toMatchObject({ ok: false, kind: 'conflict' })
    expect(writes()).toHaveLength(1)
    expect(data().hub).toMatchObject({ name: 'Theirs', color: 'pink', version: 7 })
    expect(model.hubNotice.value).toContain('your change was not saved')
  })

  it('deletes the hub with its version', async () => {
    const { model, writes } = await setup({
      [`DELETE ${hubPath}?version=2`]: () => new Response(null, { status: 204 }),
    })
    expect(await model.deleteHub()).toEqual({ ok: true, data: undefined })
    expect(writes()).toEqual([{ method: 'DELETE', path: `${hubPath}?version=2`, body: undefined }])
  })

  it('says why a delete was refused (D52)', async () => {
    const cases: [Response, string][] = [
      [
        json({ error: 'not_empty', message: 'x' }, 409),
        'The hub still holds items or folders, so it was not deleted.',
      ],
      [json({ error: 'in_use', message: 'x' }, 409), 'A relation attribute in another hub'],
      [json({ error: 'forbidden', message: 'x' }, 403), 'Your role does not allow deleting'],
    ]
    for (const [answer, text] of cases) {
      const { model } = await setup({ [`DELETE ${hubPath}?version=2`]: () => answer.clone() })
      const result = await model.deleteHub()
      expect(result.ok).toBe(false)
      expect(!result.ok && result.message).toContain(text)
    }
  })

  it('a stale delete shows the current hub and refuses', async () => {
    const current = { ...description().hub, itemCount: 1, version: 9 }
    const { model, data } = await setup({
      [`DELETE ${hubPath}?version=2`]: () => conflict(current),
    })
    const result = await model.deleteHub()
    expect(result).toMatchObject({ ok: false, kind: 'conflict' })
    expect(data().hub.version).toBe(9)
  })
})
