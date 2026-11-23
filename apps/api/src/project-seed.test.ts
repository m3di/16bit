import { hubDescriptionSchema, viewSchema } from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { createSession, DEFAULT_SESSION_POLICY, SESSION_COOKIE } from './auth/session.ts'
import { applySeed } from './demo-seed.ts'
import { DEV_OWNER } from './dev-accounts.ts'
import {
  applyProjectSeed,
  generatedTasks,
  PARCEL_HUB,
  PROJECT_TASKS,
  projectIds,
  SCALE_HUB,
  seedProjectWorkspace,
  sprintDates,
  type ProjectSeedResult,
} from './project-seed.ts'
import { validateViewTree } from './views.ts'

// The project hub seed (M4-06, #257) against a real Postgres: shape, the mockups' numbers,
// views stored through the API's own check, people, the agent key, and re-runs.

// A Monday, so sprint 24 runs Nov 9 to Nov 20 and today is its day 6, as in Main.dc.html.
const TODAY = new Date('2026-11-16T12:00:00Z')
const DEV = DEV_OWNER.id
const WS = PARCEL_HUB.workspaceId
const HUB = PARCEL_HUB.hubId
const { folders: F, attr: A } = projectIds(HUB)

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let first: ProjectSeedResult

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await applySeed(db)
  first = await applyProjectSeed(db, { today: TODAY })
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/** A session for the seeded person `who`, on their seeded account. */
async function cookie(who: string): Promise<{ cookie: string }> {
  const row = await db
    .selectFrom('principal')
    .select('account_id')
    .where('workspace_id', '=', WS)
    .where('id', '=', who)
    .executeTakeFirstOrThrow()
  const token = await createSession(db, row.account_id ?? '', DEFAULT_SESSION_POLICY)
  return { cookie: `${SESSION_COOKIE}=${token}` }
}

const as = async (
  who: string,
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/v1/workspaces/${WS}${url}`,
    headers: await cookie(who),
    ...(payload !== undefined && { payload }),
  })

interface Task {
  number: number
  values: Record<string, unknown>
}

async function backlog(): Promise<Task[]> {
  const rows = await db
    .selectFrom('item')
    .select(['seq_id', 'values'])
    .where('workspace_id', '=', WS)
    .where('folder_id', '=', F.backlog)
    .execute()
  return rows.map((r) => ({ number: r.seq_id, values: r.values }))
}

const itemId = (n: number) => `${HUB}-${String(n)}`
const one = (v: unknown) => (Array.isArray(v) ? (v[0] as unknown) : undefined)
const sum = (tasks: Task[]) =>
  tasks.reduce(
    (n, t) => n + (typeof t.values[A.points] === 'number' ? (t.values[A.points] as number) : 0),
    0,
  )

describe('the Parcel Tracker hub (M4-06)', () => {
  it('has views-only Home and My work, opens on Home, and the backlog attributes indexed', async () => {
    const res = await as('sara', 'GET', `/hubs/${HUB}`)
    expect(res.statusCode, res.body).toBe(200)
    const described = hubDescriptionSchema.parse(res.json())
    expect(described.hub).toMatchObject({
      name: 'Parcel Tracker',
      idPrefix: 'PT',
      opensOnFolderId: F.home,
      titleAttributeId: A.title,
    })
    const folders = new Map(described.folders.map((f) => [f.id, f]))
    expect([...folders.keys()].sort()).toEqual(
      [F.backlog, F.epics, F.home, F.work, F.sprints].sort(),
    )
    expect(folders.get(F.home)?.viewsOnly).toBe(true)
    expect(folders.get(F.work)?.viewsOnly).toBe(true)
    expect(folders.get(F.backlog)?.viewsOnly).toBeUndefined()

    const backlogAttrs = described.folderAttributes
      .filter((fa) => fa.folderId === F.backlog)
      .map((fa) => described.attributes.find((a) => a.id === fa.attributeId))
    expect(backlogAttrs.map((a) => a?.name)).toEqual([
      'Title',
      'Type',
      'Stage',
      'Owner',
      'Reviewer',
      'Points',
      'Sprint',
      'Epic',
      'Done on',
      'Bucket',
      'Rank',
    ])
    expect(backlogAttrs.filter((a) => a?.name !== 'Title').every((a) => a?.indexed)).toBe(true)
    expect(described.attributes.find((a) => a.id === A.type)).toMatchObject({
      type: 'select',
      config: { options: [{ label: 'Bug' }, { label: 'Story' }, { label: 'Chore' }] },
    })
  })

  it('places sprint 24 around the seed day: day 6 of 10 weekdays', async () => {
    const sprint = await db
      .selectFrom('item')
      .select('values')
      .where('workspace_id', '=', WS)
      .where('id', '=', itemId(186))
      .executeTakeFirstOrThrow()
    expect(sprint.values).toMatchObject({
      [A.title]: 'Sprint 24',
      [A.start]: '2026-11-09',
      [A.end]: '2026-11-20',
    })
    // A Saturday counts from the Friday before it.
    const [saturday] = sprintDates(new Date('2026-11-21T09:00:00Z'), 24, [0])
    expect(saturday).toEqual({ number: 24, start: '2026-11-13', end: '2026-11-26' })
  })

  it("matches the mockups' numbers", async () => {
    const tasks = await backlog()
    const inSprint = tasks.filter((t) => one(t.values[A.sprint]) === itemId(186))
    const done = (t: Task) => t.values[A.stage] === 'done'
    // Main.dc.html: points done 16 of 34, 2 in review or QA, 7 open bugs.
    expect(sum(inSprint)).toBe(34)
    expect(sum(inSprint.filter(done))).toBe(16)
    expect(
      inSprint.filter((t) => ['in-review', 'in-qa'].includes(t.values[A.stage] as string)),
    ).toHaveLength(2)
    expect(tasks.filter((t) => t.values[A.type] === 'bug' && !done(t))).toHaveLength(7)
    // Team: Sara 10 and Tomas 8 open points this sprint.
    const open = (who: string) =>
      sum(inSprint.filter((t) => !done(t) && one(t.values[A.owner]) === who))
    expect([open('sara'), open('tomas'), open('kofi')]).toEqual([10, 8, 0])

    // Work.dc.html: the backlog (no sprint) by bucket.
    const unplanned = tasks.filter((t) => t.values[A.sprint] === undefined)
    const bucket = (b: string) => unplanned.filter((t) => t.values[A.bucket] === b)
    expect(sum(bucket('next-up'))).toBe(19)
    expect(bucket('later').filter((t) => t.values[A.points] === undefined)).toHaveLength(1)
    expect(
      bucket('next-up')
        .map((t) => t.number)
        .sort(),
    ).toEqual([225, 226, 227, 228])

    // Release 2.0, per epic (D82: over all epics).
    const epic = (n: number) => tasks.filter((t) => one(t.values[A.epic]) === itemId(n))
    const ratio = (n: number) => [epic(n).filter(done).length, epic(n).length]
    expect([ratio(181), ratio(182), ratio(183)]).toEqual([
      [11, 13],
      [9, 14],
      [4, 9],
    ])

    // Item numbers as the mockups show them, and done-on dates inside their sprints.
    expect(tasks.find((t) => t.number === 214)?.values[A.title]).toBe('Delivery window picker')
    expect(tasks.find((t) => t.number === 217)?.values[A.title]).toBe(
      'Push notification on status change',
    )
    const doneOn = inSprint.filter(done).map((t) => t.values[A.doneOn] as string)
    expect(doneOn.sort()).toEqual(['2026-11-10', '2026-11-11', '2026-11-13'])
  })

  it('stores both root views, valid under PUT /view rules, readable by every reader', async () => {
    expect(first.viewsStored.sort()).toEqual([F.home, F.work].sort())
    for (const folderId of [F.home, F.work]) {
      for (const who of ['sara', 'ivy']) {
        const res = await as(who, 'GET', `/folders/${folderId}/view`)
        expect(res.statusCode, res.body).toBe(200)
        const view = viewSchema.parse(res.json())
        expect(view).toMatchObject({ stored: true, version: 1 })
        expect(await validateViewTree(db, WS, HUB, view.tree)).toMatchObject({ ok: true })
      }
    }
    const work = viewSchema.parse((await as('sara', 'GET', `/folders/${F.work}/view`)).json())
    expect(JSON.stringify(work.tree)).toContain('"$me":true')
    // The default (dev owner, hub admin) can save it back unchanged.
    const saved = await as(DEV, 'PUT', `/folders/${F.work}/view`, { version: 1, tree: work.tree })
    expect(saved.statusCode, saved.body).toBe(200)
  })

  it('grants editors, a viewer and an agent key; views-only folders refuse their items', async () => {
    const hub = (who: string) => as(who, 'GET', `/hubs/${HUB}`)
    for (const who of ['sara', 'tomas', 'kofi', 'priya', 'lena']) {
      expect(hubDescriptionSchema.parse((await hub(who)).json()).hubRole, who).toBe('editor')
    }
    expect(hubDescriptionSchema.parse((await hub('ivy')).json()).hubRole).toBe('viewer')
    expect(hubDescriptionSchema.parse((await hub(DEV)).json()).hubRole).toBe('hub_admin')
    // Only a hub admin edits views (D78).
    const view = viewSchema.parse((await as('sara', 'GET', `/folders/${F.home}/view`)).json())
    expect(
      (await as('sara', 'PUT', `/folders/${F.home}/view`, { version: 1, tree: view.tree }))
        .statusCode,
    ).toBe(403)

    expect(first.agentKey).toMatchObject({ workspaceId: WS, hubId: HUB, principalId: 'qa-agent' })
    const secret = first.agentKey?.secret ?? ''
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${WS}/items`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { folderId: F.home, values: {} },
    })
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json()).toMatchObject({ error: 'views_only' })
    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${WS}/items`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { folderId: F.backlog, values: { [A.title]: 'From the agent', [A.stage]: 'to-do' } },
    })
    expect(created.statusCode, created.body).toBe(201)
  })

  it('writes nothing on a second run, and keeps a view a hub admin edited', async () => {
    const home = viewSchema.parse((await as(DEV, 'GET', `/folders/${F.home}/view`)).json())
    const edited = {
      ...home.tree,
      root: { ...home.tree.root, config: { title: 'Edited by an admin' } },
    }
    const put = await as(DEV, 'PUT', `/folders/${F.home}/view`, { version: 1, tree: edited })
    expect(put.statusCode, put.body).toBe(200)
    const before = hubDescriptionSchema.parse((await as(DEV, 'GET', `/hubs/${HUB}`)).json()).hub
    const opens = await as(DEV, 'PATCH', `/hubs/${HUB}`, {
      version: before.version,
      opensOnFolderId: F.work,
    })
    expect(opens.statusCode, opens.body).toBe(200)

    await applySeed(db)
    const again = await applyProjectSeed(db, { today: new Date('2026-12-01T12:00:00Z') })
    expect(again).toMatchObject({ itemsCreated: 0, viewsStored: [], agentKey: null })
    const after = viewSchema.parse((await as(DEV, 'GET', `/folders/${F.home}/view`)).json())
    expect(after).toMatchObject({
      version: 2,
      tree: { root: { config: { title: 'Edited by an admin' } } },
    })
    const hub = hubDescriptionSchema.parse((await as(DEV, 'GET', `/hubs/${HUB}`)).json()).hub
    expect(hub.opensOnFolderId).toBe(F.work)
  })

  it('leaves a hub deleted through the API deleted', async () => {
    await db
      .insertInto('deleted_hub')
      .values({ workspace_id: WS, id: 'scale', deleted_by: DEV })
      .execute()
    await seedProjectWorkspace(db, { ...SCALE_HUB, workspaceId: WS })
    const result = await applyProjectSeed(db, { hub: { ...SCALE_HUB, workspaceId: WS } })
    expect(result.hubDeleted).toBe(true)
    const row = await db
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', WS)
      .where('id', '=', 'scale')
      .executeTakeFirst()
    expect(row).toBeUndefined()
  })
})

describe('the 2,000-task fixture (seed:large --project)', () => {
  it(`builds the same shape with ${String(PROJECT_TASKS)} tasks and both views`, async () => {
    await seedProjectWorkspace(db, SCALE_HUB)
    const result = await applyProjectSeed(db, {
      hub: SCALE_HUB,
      tasks: generatedTasks(PROJECT_TASKS),
      today: TODAY,
    })
    // 3 epics and 4 sprints besides the tasks.
    expect(result).toMatchObject({
      hubDeleted: false,
      itemsCreated: PROJECT_TASKS + 7,
      agentKey: null,
    })
    expect(result.viewsStored).toHaveLength(2)
    const { folders } = projectIds(SCALE_HUB.hubId)
    const count = await db
      .selectFrom('folder')
      .select('item_count')
      .where('workspace_id', '=', SCALE_HUB.workspaceId)
      .where('id', '=', folders.backlog)
      .executeTakeFirstOrThrow()
    expect(count.item_count).toBe(PROJECT_TASKS)
  }, 120_000)
})
