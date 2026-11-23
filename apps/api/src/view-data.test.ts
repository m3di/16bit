import { viewDataSchema, viewSchema, type BlockStatus, type ViewData } from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createSession, DEFAULT_SESSION_POLICY, SESSION_COOKIE } from './auth/session.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { applySeed } from './demo-seed.ts'
import { DEV_OWNER } from './dev-accounts.ts'
import { applyProjectSeed, PARCEL_HUB, projectIds } from './project-seed.ts'

// View data (M4-05, #256, D83) on the seeded Parcel Tracker hub (#257): its two root views give
// the mockups' numbers, per reader; per-block statuses, the snapshot, stale versions, subsets,
// caps, the deadline and the per-principal limit. The hub is seeded once for the file, for
// today, so "today" in the views (the database clock) is the seed's day; tests that change data
// run last.

const WS = PARCEL_HUB.workspaceId
const HUB = PARCEL_HUB.hubId
const { folders: F, attr: A } = projectIds(HUB)
const DEV = DEV_OWNER.id

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance

beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await applySeed(db)
  await applyProjectSeed(db, { today: new Date() })
  app = buildApp({ db: appDb })
}, 180_000)

afterAll(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

const sessions = new Map<string, string>()
async function cookie(who: string): Promise<{ cookie: string }> {
  const known = sessions.get(who)
  if (known) return { cookie: known }
  const row = await db
    .selectFrom('principal')
    .select('account_id')
    .where('workspace_id', '=', WS)
    .where('id', '=', who)
    .executeTakeFirstOrThrow()
  const token = await createSession(db, row.account_id ?? '', DEFAULT_SESSION_POLICY)
  sessions.set(who, `${SESSION_COOKIE}=${token}`)
  return { cookie: `${SESSION_COOKIE}=${token}` }
}

const call = async (
  on: FastifyInstance,
  who: string,
  url: string,
  method = 'GET',
  payload?: object,
) =>
  on.inject({
    method: method as 'GET',
    url: `/v1/workspaces/${WS}${url}`,
    headers: await cookie(who),
    ...(payload !== undefined && { payload }),
  })

async function versionOf(folderId: string): Promise<number> {
  const res = await call(app, DEV, `/folders/${folderId}/view`)
  expect(res.statusCode, res.body).toBe(200)
  return viewSchema.parse(res.json()).version
}

async function data(who: string, folderId: string, query = '', on = app): Promise<ViewData> {
  const version = await versionOf(folderId)
  const res = await call(
    on,
    who,
    `/folders/${folderId}/view/data?version=${String(version)}${query}`,
  )
  expect(res.statusCode, res.body).toBe(200)
  return viewDataSchema.parse(res.json())
}

function ok(status: BlockStatus | undefined) {
  if (status?.status !== 'ok') throw new Error(`not ok: ${JSON.stringify(status)}`)
  return status.data
}
const first = (status: BlockStatus | undefined) => {
  const d = ok(status)
  if (d.kind !== 'aggregate') throw new Error(`not an aggregate: ${d.kind}`)
  return d.groups[0]?.values
}

describe('the seeded project home (Main.dc.html)', () => {
  it('answers the mockup’s numbers in one snapshot', async () => {
    const home = await data('sara', F.home)
    expect(home.folderId).toBe(F.home)
    expect(home.seq).toBeGreaterThan(0)
    expect(Object.keys(home.blocks).sort()).toEqual(
      [
        'burndown',
        'current-work-list',
        'epic-bars',
        'in-review',
        'open-bugs',
        'points-done',
        'sprint',
        'sprint-day',
        'team-points',
      ].sort(),
    )
    // "Sprint 24 runs ..." and "day 6 of 10" (weekdays, D81).
    const sprint = ok(home.blocks['sprint'])
    expect(sprint.kind === 'item' && sprint.item?.values[A.title]).toBe('Sprint 24')
    expect(ok(home.blocks['sprint-day'])).toEqual({ kind: 'days', day: 6, of: 10 })
    // "16 of 34" points done, 2 in review or QA, 7 open bugs.
    expect(first(home.blocks['points-done'])).toEqual([16, 34])
    expect(first(home.blocks['in-review'])).toEqual([2])
    expect(first(home.blocks['open-bugs'])).toEqual([7])
    // The burndown: done on days 2, 3 and 5 (8, 3 and 5 points); today is day 6.
    const burndown = ok(home.blocks['burndown'])
    if (burndown.kind !== 'burndown') throw new Error(burndown.kind)
    expect(burndown.total).toBe(34)
    expect(burndown.days.map((d) => d.remaining)).toEqual([
      34,
      26,
      23,
      23,
      18,
      18,
      null,
      null,
      null,
      null,
    ])
    // Team open points, grouped by owner: Sara 10, Tomas 8.
    const team = ok(home.blocks['team-points'])
    if (team.kind !== 'items') throw new Error(team.kind)
    expect(
      team.groups?.map((g) => [g.key.kind === 'value' ? g.key.value : g.key.kind, g.values[0]]),
    ).toEqual([
      ['sara', 10],
      ['tomas', 8],
    ])
    // Epics: 11 of 13, 9 of 14, 4 of 9 done (D82), labelled with their titles.
    const bars = ok(home.blocks['epic-bars'])
    if (bars.kind !== 'aggregate') throw new Error(bars.kind)
    const byLabel = Object.fromEntries(
      bars.groups.flatMap((g) =>
        g.key.kind === 'value' && g.key.label ? [[g.key.label, g.values]] : [],
      ),
    )
    expect(byLabel).toEqual({
      'Courier tools': [11, 13],
      'Tracking page': [9, 14],
      Notifications: [4, 9],
    })
    const list = ok(home.blocks['current-work-list'])
    expect(list.kind === 'items' && list.total).toBe(7)
  })

  it('gives each reader their own "my work" ($me)', async () => {
    const sara = await data('sara', F.work)
    const tomas = await data('tomas', F.work)
    expect(first(sara.blocks['my-points'])).toEqual([10])
    expect(first(tomas.blocks['my-points'])).toEqual([8])
    const cards = (d: ViewData) => {
      const board = ok(d.blocks['my-board'])
      if (board.kind !== 'board') throw new Error(board.kind)
      return Object.fromEntries(
        board.columns.map((c) => [c.option, c.items.map((i) => i.values[A.title])]),
      )
    }
    expect(cards(sara)).toEqual({
      'to-do': ['Review the live map PR'],
      'in-progress': ['Delivery window picker'],
      'in-review': [],
      'in-qa': ['Push notification on status change'],
    })
    // Kofi reviews Tomas's live map: it is on both boards.
    expect(cards(tomas)['in-review']).toEqual(['Live map on tracking page'])
    expect(cards(await data('kofi', F.work))['in-review']).toEqual(['Live map on tracking page'])
    // Backlog: Next up 19 points, Later one not estimated.
    const backlog = ok(sara.blocks['backlog-list'])
    if (backlog.kind !== 'items') throw new Error(backlog.kind)
    expect(
      backlog.groups?.map((g) => [g.key.kind === 'value' ? g.key.value : g.key.kind, g.values]),
    ).toEqual([
      ['next-up', [19, 0]],
      ['later', [13, 1]],
    ])
    // Epic labels for the rows come with the items.
    expect(Object.values(backlog.linked ?? {}).some((l) => l.access === 'read')).toBe(true)
  })

  it('answers only the blocks asked for, and the default view of a folder with none', async () => {
    const some = await data('sara', F.home, '&blocks=points-done,open-bugs,heading,nope')
    expect(Object.keys(some.blocks).sort()).toEqual(['open-bugs', 'points-done'])
    // `points-done` still sees the current sprint, resolved though it wasn't asked for.
    expect(first(some.blocks['points-done'])).toEqual([16, 34])
    const backlog = await data('sara', F.backlog)
    expect(backlog.version).toBe(0)
    const table = ok(backlog.blocks['table'])
    // The earlier sprints' 21 tasks and the 19 of the mockups.
    expect(table.kind === 'items' && table.total).toBe(40)
  })

  it('answers 409 stale past the version, 404 hidden, 422 for an unknown zone', async () => {
    const version = await versionOf(F.home)
    const stale = await call(
      app,
      'sara',
      `/folders/${F.home}/view/data?version=${String(version + 1)}`,
    )
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'stale', version })
    expect(
      (await call(app, 'leo', `/folders/${F.home}/view/data?version=${String(version)}`))
        .statusCode,
    ).toBe(404)
    expect((await call(app, 'sara', `/folders/nope/view/data?version=0`)).statusCode).toBe(404)
    const zone = await call(
      app,
      'sara',
      `/folders/${F.home}/view/data?version=${String(version)}&tz=Mars/Base`,
    )
    expect(zone.statusCode).toBe(422)
    // A viewer reads the same numbers.
    expect(first((await data('ivy', F.home)).blocks['open-bugs'])).toEqual([7])
  })

  it('caps the items of a response, block by block', async () => {
    const capped = buildApp({ db: appDb, viewDataMaxItems: 3 })
    try {
      const home = await data('sara', F.home, '', capped)
      // The sprint's item fits; the 7-item list doesn't, and says so; numbers carry no items.
      expect(home.blocks['sprint']?.status).toBe('ok')
      expect(home.blocks['current-work-list']).toEqual({ status: 'error', error: 'item_cap' })
      expect(first(home.blocks['points-done'])).toEqual([16, 34])
    } finally {
      await capped.close()
    }
  })

  it('answers error timeout for every block past the deadline', async () => {
    const late = buildApp({ db: appDb, viewDataDeadlineMs: 0 })
    try {
      const home = await data('sara', F.home, '', late)
      expect(
        Object.values(home.blocks).every((b) => b.status === 'error' && b.error === 'timeout'),
      ).toBe(true)
    } finally {
      await late.close()
    }
  })

  it('answers a fifth request in flight from one principal with 429, and serves the four', async () => {
    const version = await versionOf(F.home)
    const url = `/folders/${F.home}/view/data?version=${String(version)}`
    // Hold the view table, so the first four requests wait inside their slots.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => undefined
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    const lock = db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE view IN ACCESS EXCLUSIVE MODE`.execute(trx)
      locked()
      await held
    })
    await isLocked
    const headers = await cookie('sara')
    const four = Array.from({ length: 4 }, () =>
      app.inject({ method: 'GET', url: `/v1/workspaces/${WS}${url}`, headers }),
    )
    // Let the four reach the lock.
    for (let i = 0; i < 50; i++) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()
      `.execute(db)
      if ((rows[0]?.n ?? 0) >= 4) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const fifth = await app.inject({ method: 'GET', url: `/v1/workspaces/${WS}${url}`, headers })
    expect(fifth.statusCode).toBe(429)
    expect(fifth.json()).toMatchObject({ error: 'rate_limited' })
    // Another principal is not limited by Sara's requests (it waits on the lock like hers).
    const tomas = app.inject({
      method: 'GET',
      url: `/v1/workspaces/${WS}${url}`,
      headers: await cookie('tomas'),
    })
    release()
    await lock
    expect((await Promise.all(four)).map((r) => r.statusCode)).toEqual([200, 200, 200, 200])
    expect((await tomas).statusCode).toBe(200)
    // The slots are free again.
    expect((await call(app, 'sara', url)).statusCode).toBe(200)
  }, 30_000)
})

describe('blocks that can no longer run (these tests change data)', () => {
  it('sends every group of a grouped list, labelled and counted, even without measures (#291)', async () => {
    const list = (id: string, attribute: string) => ({
      id,
      type: 'list',
      config: { binding: { folderId: F.backlog, limit: 2 }, groupBy: { attribute } },
    })
    const tree = {
      schemaVersion: 1,
      root: {
        id: 'page',
        type: 'page',
        config: {},
        children: [list('by-epic', A.epic), list('by-stage', A.stage)],
      },
    }
    const put = await call(app, DEV, `/folders/${F.sprints}/view`, 'PUT', { version: 0, tree })
    expect(put.statusCode, put.body).toBe(200)
    const view = await data('sara', F.sprints)
    const groupsOf = (id: string) => {
      const d = ok(view.blocks[id])
      if (d.kind !== 'items') throw new Error(d.kind)
      // Only 2 rows came back: the groups cover all 40 items, not just these.
      expect(d.items).toHaveLength(2)
      return d.groups?.map((g) => [
        g.key.kind === 'value' ? (g.key.label ?? g.key.value) : g.key.kind,
        ...g.values,
      ])
    }
    // Relation groups: largest first, labelled with the epic's title; then items with no epic.
    expect(groupsOf('by-epic')).toEqual([
      ['Tracking page', 14],
      ['Courier tools', 13],
      ['Notifications', 9],
      ['empty', 4],
    ])
    // Select groups: in option order, every one present.
    expect(groupsOf('by-stage')).toEqual([
      ['to-do', 13],
      ['in-progress', 1],
      ['in-review', 1],
      ['in-qa', 1],
      ['done', 24],
    ])
  })

  it('answers not_found for a fixed item that is gone, ok with nothing for a rule that finds none', async () => {
    const made = await call(app, DEV, '/items', 'POST', {
      folderId: F.epics,
      values: { [A.title]: 'Temp' },
    })
    expect(made.statusCode, made.body).toBe(201)
    const item = made.json<{ id: string; version: number }>()
    const tree = {
      schemaVersion: 1,
      root: {
        id: 'page',
        type: 'page',
        config: {},
        children: [
          {
            id: 'fixed',
            type: 'fields',
            config: {
              binding: { by: 'item', folderId: F.epics, itemId: item.id },
              fields: [A.title],
            },
          },
          {
            id: 'none',
            type: 'fields',
            config: {
              binding: {
                by: 'rule',
                folderId: F.sprints,
                where: { attribute: A.start, op: 'eq', value: '1999-01-01' },
              },
              fields: [A.title],
            },
          },
        ],
      },
    }
    const put = await call(app, DEV, `/folders/${F.epics}/view`, 'PUT', { version: 0, tree })
    expect(put.statusCode, put.body).toBe(200)
    expect(ok((await data('sara', F.epics)).blocks['fixed'])).toMatchObject({
      kind: 'item',
      item: { id: item.id },
    })
    const del = await call(app, DEV, `/items/${item.id}?version=${String(item.version)}`, 'DELETE')
    expect(del.statusCode).toBe(204)
    const after = await data('sara', F.epics)
    expect(after.blocks['fixed']).toEqual({ status: 'not_found' })
    expect(ok(after.blocks['none'])).toEqual({ kind: 'item', item: null })
  })

  it('makes only the blocks that use a removed attribute invalid', async () => {
    // Bucket leaves the Backlog: only "my work"'s backlog list groups by it.
    await sql`DELETE FROM folder_attribute WHERE workspace_id = ${WS} AND folder_id = ${F.backlog} AND attribute_id = ${A.bucket}`.execute(
      db,
    )
    const work = await data('sara', F.work)
    expect(work.blocks['backlog-list']?.status).toBe('invalid')
    const others = Object.entries(work.blocks).filter(([id]) => id !== 'backlog-list')
    expect(others.every(([, b]) => b.status === 'ok')).toBe(true)
  })

  it('makes the blocks that need the current sprint unresolved when there is none', async () => {
    // Every sprint moves a year back, so no sprint holds today.
    await sql`
      UPDATE item_index SET ts = ts - interval '365 days'
      WHERE workspace_id = ${WS} AND attribute_id IN (${A.start}, ${A.end})
    `.execute(db)
    const home = await data('sara', F.home)
    expect(ok(home.blocks['sprint'])).toEqual({ kind: 'item', item: null })
    expect(ok(home.blocks['sprint-day'])).toEqual({ kind: 'days', day: null, of: null })
    for (const id of ['points-done', 'in-review', 'burndown', 'current-work-list', 'team-points']) {
      expect(home.blocks[id], id).toEqual({ status: 'unresolved', blocks: ['sprint'] })
    }
    // Blocks that don't name the sprint still answer.
    expect(first(home.blocks['open-bugs'])).toEqual([7])
    expect(home.blocks['epic-bars']?.status).toBe('ok')
  })
})
