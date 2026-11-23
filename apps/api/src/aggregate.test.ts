import {
  aggregateResultSchema,
  createdAgentKeySchema,
  itemQueryResultSchema,
  itemWriteResultSchema,
  type AggregateGroup,
  type Filter,
  type HubRole,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { applyLargeSeed, LARGE_ATTR, LARGE_FOLDER, LARGE_WORKSPACE } from './large-seed.ts'

// The aggregate engine (D80, #255) and `$me`/`$now` in reads (D79, D81), against a real Postgres
// under row-level security. The 50,000-item budget is in query-window.test.ts, which shares the
// seed.

const WS = 'w1'
const PEOPLE = ['own', 'ed', 'vw', 'none'] as const

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
const auth = new Map<string, Record<string, string>>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  app = buildApp({ db: appDb })
}, 60_000)

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

async function start(options: { aggregateTimeoutMs?: number } = {}) {
  await app.close()
  app = buildApp({ db: appDb, ...options })
  for (const p of PEOPLE) auth.set(p, { cookie: (await sessionCookie(db, p)).cookie })
}

const call = (who: string, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url: `/v1/workspaces/${WS}${url}`,
    headers: auth.get(who) ?? {},
    ...(payload !== undefined && { payload }),
  })

async function agg(who: string, body: object) {
  const res = await call(who, 'POST', '/aggregate', { from: 'f1', ...body })
  expect(res.statusCode, res.body).toBe(200)
  return aggregateResultSchema.parse(res.json())
}
const keys = (groups: AggregateGroup[]) =>
  groups.map((g) => (g.key.kind === 'value' ? g.key.value : g.key.kind))

/**
 * Hub h1, folder f1: title (text), stage (select todo/doing/done), tags (multi-select a/b/c),
 * owner (actor), pts (number, 1 decimal), done (boolean), due (date), at (date with time),
 * link (url), rel (relation into h1, several) and xrel (relation into h2, cross-hub), all
 * indexed but notes. Hub h2 shows t2 and is its own title. own: owner, hub admin of both. ed:
 * editor of h1 only. vw: viewer of h1. none: no grant.
 */
async function seed(): Promise<void> {
  const opts = (ids: string[]) => JSON.stringify({ options: ids.map((id) => ({ id, label: id })) })
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'W');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'Owner', 'owner'), ('w1', 'ed', 'user', 'Ed', 'member'),
      ('w1', 'vw', 'user', 'Vi', 'member'), ('w1', 'none', 'user', 'None', 'member');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'h1', 'blue', 'ONE'), ('w1', 'h2', 'h2', NULL, 'h2', 'red', 'TWO');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
      VALUES ('w1', 'f1', 'h1', 'h1', 'f1', 'blue', 'ONE');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, config, indexed) VALUES
      ('w1', 'title', 'h1', 'Title', 'text', '{}', true),
      ('w1', 'stage', 'h1', 'Stage', 'select', ${sql.lit(opts(['todo', 'doing', 'done']))}, true),
      ('w1', 'tags', 'h1', 'Tags', 'multi_select', ${sql.lit(opts(['a', 'b', 'c']))}, true),
      ('w1', 'owner', 'h1', 'Owner', 'actor', '{"multiple":false}', true),
      ('w1', 'pts', 'h1', 'Points', 'number', '{"decimals":1}', true),
      ('w1', 'done', 'h1', 'Done', 'boolean', '{}', true),
      ('w1', 'due', 'h1', 'Due', 'date', '{}', true),
      ('w1', 'at', 'h1', 'At', 'date', '{"includeTime":true}', true),
      ('w1', 'link', 'h1', 'Link', 'url', '{}', true),
      ('w1', 'rel', 'h1', 'Rel', 'relation', '{"targetHubId":"h1","multiple":true}', true),
      ('w1', 'xrel', 'h1', 'XRel', 'relation',
        '{"targetHubId":"h2","crossHub":true,"multiple":true}', true),
      ('w1', 'notes', 'h1', 'Notes', 'text', '{}', false),
      ('w1', 't2', 'h2', 'T2', 'text', '{}', true);
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
      SELECT 'w1', 'h1', 'f1', a, p FROM unnest(ARRAY['title','stage','tags','owner','pts',
        'done','due','at','link','rel','xrel','notes']) WITH ORDINALITY AS t(a, p);
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
      VALUES ('w1', 'h2', 'h2', 't2', 0), ('w1', 'h1', 'h1', 'title', 0);
    UPDATE folder SET title_attribute_id = 'title' WHERE id = 'h1';
    UPDATE folder SET title_attribute_id = 't2' WHERE id = 'h2';
  `.execute(db)
  const grant = (hub: string, principal: string, role: HubRole) => ({
    workspace_id: WS,
    hub_id: hub,
    principal_id: principal,
    hub_role: role,
  })
  await db
    .insertInto('hub_grant')
    .values([
      grant('h1', 'own', 'hub_admin'),
      grant('h2', 'own', 'hub_admin'),
      grant('h1', 'ed', 'editor'),
      grant('h1', 'vw', 'viewer'),
    ])
    .execute()
}

async function create(values: Record<string, unknown>, id?: string, folderId = 'f1') {
  const res = await call('own', 'POST', '/items', { folderId, values, ...(id && { id }) })
  expect(res.statusCode, res.body).toBe(201)
  return itemWriteResultSchema.parse(res.json())
}

/** Six items in f1, one in h1's root (never counted from f1), two in h2. */
const ROWS: Record<string, unknown>[] = [
  {
    title: 'A',
    stage: 'todo',
    tags: ['a', 'b'],
    owner: ['own'],
    pts: 1.1,
    done: false,
    due: '2026-11-16',
    at: '2026-11-16T23:30:00Z',
    link: 'https://x.example/1',
  },
  {
    title: 'B',
    stage: 'doing',
    tags: ['b'],
    owner: ['ed'],
    pts: 2.2,
    done: true,
    due: '2026-11-17',
    at: '2026-11-17T08:00:00Z',
    link: 'https://x.example/1',
  },
  {
    title: 'C',
    stage: 'done',
    tags: [],
    owner: ['ed'],
    pts: 0.1,
    done: true,
    due: '2026-11-23',
    link: 'https://x.example/2',
  },
  { title: 'D', stage: 'done', tags: ['c'], owner: ['own'], done: false, due: '2026-11-30' },
  { title: 'E', tags: ['a'], pts: 10, at: '2026-11-18T00:30:00Z' },
  { title: 'F', stage: 'todo', owner: ['own'], pts: 0.2 },
]

async function seedItems() {
  const ids: string[] = []
  for (const [i, values] of ROWS.entries()) ids.push((await create(values, `i${String(i)}`)).id)
  await create({ title: 'root' }, 'root', 'h1')
  await create({ t2: 'Hidden one' }, 'x1', 'h2')
  await create({ t2: 'Hidden two' }, 'x2', 'h2')
  return ids
}

describe('POST /aggregate', () => {
  beforeEach(async () => {
    await seed()
    await start()
    await seedItems()
  })

  it('computes every summary function on its types, without a group', async () => {
    const all = async (measures: object[]) => (await agg('ed', { measures })).groups
    const [counts] = await all([
      { fn: 'count' },
      { fn: 'count_empty', attribute: 'pts' },
      { fn: 'count_not_empty', attribute: 'pts' },
      { fn: 'count_unique', attribute: 'stage' },
      { fn: 'count_unique', attribute: 'link' },
    ])
    expect(counts).toEqual({ key: { kind: 'all' }, values: [6, 1, 5, 3, 2] })
    const [numbers] = await all([
      { fn: 'sum', attribute: 'pts' },
      { fn: 'avg', attribute: 'pts' },
      { fn: 'min', attribute: 'pts' },
      { fn: 'max', attribute: 'pts' },
      { fn: 'count_unique', attribute: 'title' },
    ])
    // 1.1 + 2.2 + 0.1 + 10 + 0.2 = 13.6, exactly, and its mean to 1 decimal.
    expect(numbers?.values).toEqual([13.6, 2.7, 0.1, 10, 6])
    const [dates] = await all([
      { fn: 'earliest', attribute: 'due' },
      { fn: 'latest', attribute: 'due' },
      { fn: 'earliest', attribute: 'at' },
      { fn: 'count_true', attribute: 'done' },
      { fn: 'count_false', attribute: 'done' },
    ])
    expect(dates?.values).toEqual(['2026-11-16', '2026-11-30', '2026-11-16T23:30:00.000Z', 2, 2])
  })

  it('groups by a select in option order, with measures that have their own where', async () => {
    const { groups, truncated } = await agg('ed', {
      groupBy: { attribute: 'stage' },
      measures: [
        { fn: 'count' },
        { fn: 'count', where: { attribute: 'done', op: 'eq', value: true } },
        { fn: 'sum', attribute: 'pts' },
      ],
    })
    expect(truncated).toBe(false)
    expect(groups).toEqual([
      { key: { kind: 'value', value: 'todo' }, values: [2, 0, 1.3] },
      { key: { kind: 'value', value: 'doing' }, values: [1, 1, 2.2] },
      { key: { kind: 'value', value: 'done' }, values: [2, 1, 0.1] },
      { key: { kind: 'empty' }, values: [1, 0, 10] },
    ])
  })

  it('counts an item in each group of a multi-valued attribute', async () => {
    const { groups } = await agg('ed', {
      groupBy: { attribute: 'tags' },
      measures: [{ fn: 'count' }],
    })
    expect(groups.map((g) => [keys([g])[0], g.values[0]])).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 1],
      ['empty', 2],
    ])
  })

  it('groups booleans false, true, then empty', async () => {
    const { groups } = await agg('ed', {
      groupBy: { attribute: 'done' },
      measures: [{ fn: 'count' }],
    })
    expect(groups).toEqual([
      { key: { kind: 'value', value: false }, values: [2] },
      { key: { kind: 'value', value: true }, values: [2] },
      { key: { kind: 'empty' }, values: [2] },
    ])
  })

  it('buckets dates by day, week and month, a time in the reader’s zone, a date as is', async () => {
    const at = async (bucket: string, tz?: string) =>
      (
        await agg('ed', {
          groupBy: { attribute: 'at', bucket },
          measures: [{ fn: 'count' }],
          ...(tz && { tz }),
        })
      ).groups
    expect(keys(await at('day'))).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', 'empty'])
    // 23:30 UTC on the 16th is the 17th in Auckland; 00:30 UTC on the 18th is the 17th in New York.
    expect(keys(await at('day', 'Pacific/Auckland'))).toEqual(['2026-11-17', '2026-11-18', 'empty'])
    expect((await at('day', 'America/New_York')).map((g) => [keys([g])[0], g.values[0]])).toEqual([
      ['2026-11-16', 1],
      ['2026-11-17', 2],
      ['empty', 3],
    ])
    // Weeks start on Monday (Nov 16, 2026 is a Monday).
    const due = async (bucket: string, tz: string) =>
      (await agg('ed', { groupBy: { attribute: 'due', bucket }, measures: [{ fn: 'count' }], tz }))
        .groups
    expect(
      (await due('week', 'Pacific/Kiritimati')).map((g) => [keys([g])[0], g.values[0]]),
    ).toEqual([
      ['2026-11-16', 2],
      ['2026-11-23', 1],
      ['2026-11-30', 1],
      ['empty', 2],
    ])
    expect(keys(await due('day', 'Pacific/Pago_Pago'))).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-23',
      '2026-11-30',
      'empty',
    ])
    expect(keys(await due('month', 'UTC'))).toEqual(['2026-11-01', 'empty'])
  })

  it('returns actor groups as principal IDs only, for an agent too', async () => {
    const key = await call('own', 'POST', '/hubs/h1/agent-keys', { name: 'Bot', hubRole: 'viewer' })
    expect(key.statusCode, key.body).toBe(201)
    auth.set('agent', { authorization: `Bearer ${createdAgentKeySchema.parse(key.json()).secret}` })
    for (const who of ['ed', 'agent']) {
      const { groups } = await agg(who, {
        groupBy: { attribute: 'owner' },
        measures: [{ fn: 'count' }],
      })
      // Largest first, then by ID; no names, kinds or labels.
      expect(groups).toEqual([
        { key: { kind: 'value', value: 'own' }, values: [3] },
        { key: { kind: 'value', value: 'ed' }, values: [2] },
        { key: { kind: 'empty' }, values: [1] },
      ])
    }
  })

  it('folds relation targets the reader can’t see into one no_access group, without IDs', async () => {
    const [a, b, c] = ['i0', 'i1', 'i2']
    const patch = async (id: string, values: object) => {
      const item = await call('own', 'GET', `/items/${id}`)
      const { version } = item.json<{ version: number }>()
      const res = await call('own', 'PATCH', `/items/${id}`, { version, values })
      expect(res.statusCode, res.body).toBe(200)
    }
    await patch(a, { xrel: ['x1', 'x2'], rel: [b] })
    await patch(b, { xrel: ['x1'], rel: [b, c] })
    await patch(c, { xrel: ['x2'] })
    const body = { groupBy: { attribute: 'xrel' }, measures: [{ fn: 'count' }] }
    // The owner reads h2: one group per target, labelled with its title.
    expect((await agg('own', body)).groups).toEqual([
      { key: { kind: 'value', value: 'x1', label: 'Hidden one' }, values: [2] },
      { key: { kind: 'value', value: 'x2', label: 'Hidden two' }, values: [2] },
      { key: { kind: 'empty' }, values: [3] },
    ])
    // ed can't: one no_access group, each item once, no IDs, labels or count of targets.
    const hidden = await agg('ed', body)
    expect(hidden.groups).toEqual([
      { key: { kind: 'no_access' }, values: [3] },
      { key: { kind: 'empty' }, values: [3] },
    ])
    expect(JSON.stringify(hidden)).not.toMatch(/x1|x2|Hidden/)
    // A relation in the reader's own hub shows labels.
    expect(
      (await agg('ed', { groupBy: { attribute: 'rel' }, measures: [{ fn: 'count' }] })).groups,
    ).toEqual([
      { key: { kind: 'value', value: b, label: 'B' }, values: [2] },
      { key: { kind: 'value', value: c, label: 'C' }, values: [1] },
      { key: { kind: 'empty' }, values: [4] },
    ])
  })

  it('folds groups past 100 into one other group, each item once', async () => {
    // 104 items, each linking to the one before it (the first to i5) and to i0: 105 targets,
    // i0 in every one of the 104, every other target in exactly one. Each has 1 point.
    let previous = 'i5'
    for (let n = 0; n < 104; n++) {
      const made = await create(
        { title: `L${String(n)}`, pts: 1, rel: [previous, 'i0'] },
        `l${String(n).padStart(3, '0')}`,
      )
      previous = made.id
    }
    // Ranked by the first measure, which leaves out the item `Two` added below, so adding it
    // changes no group's rank.
    const body = {
      groupBy: { attribute: 'rel' },
      measures: [
        { fn: 'count', where: { attribute: 'title', op: 'neq', value: 'Two' } },
        { fn: 'count' },
        { fn: 'sum', attribute: 'pts' },
      ],
    }
    const before = await agg('ed', body)
    expect(before.truncated).toBe(true)
    const values = before.groups.filter((g) => g.key.kind === 'value')
    expect(values).toHaveLength(100)
    // i0 first (104 items), then by ID, one item each: i5, l000 to l097.
    expect(values[0]).toMatchObject({ key: { value: 'i0' }, values: [104, 104, 104] })
    expect(values.slice(1).every((g) => g.values[0] === 1)).toBe(true)
    expect(values.at(-1)).toMatchObject({ key: { value: 'l097' } })
    expect(keys(before.groups).slice(-2)).toEqual(['empty', 'other'])
    // Targets l098 to l102 fold into `other`: the five items linking to them, each once, though
    // every one of them also links to i0.
    expect(before.groups.at(-1)).toEqual({ key: { kind: 'other' }, values: [5, 5, 5] })

    // An item linking to two folded targets is in `other` once: its count grows by 1 and its
    // sum by the item's 10 points, not twice that.
    await create({ title: 'Two', pts: 10, rel: ['l100', 'l101'] }, 'two')
    const after = await agg('ed', body)
    expect(after.groups.filter((g) => g.key.kind === 'value').map((g) => g.key)).toEqual(
      values.map((g) => g.key),
    )
    expect(after.groups.at(-1)).toEqual({ key: { kind: 'other' }, values: [5, 6, 15] })
  })

  it('keeps the latest 366 date buckets, ascending, and folds the oldest into other', async () => {
    // 370 more items, one a day from 2025-01-01, next to the fixture's four November 2026 days.
    await sql`
      INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
      SELECT 'w1', 'd' || n, 'h1', 'f1', 1000 + n,
             jsonb_build_object('due', to_char(date '2025-01-01' + n, 'YYYY-MM-DD')), 'own'
      FROM generate_series(0, 369) n;
      INSERT INTO item_index (workspace_id, attribute_id, item_id, ts)
      SELECT 'w1', 'due', 'd' || n, (date '2025-01-01' + n)::timestamp AT TIME ZONE 'UTC'
      FROM generate_series(0, 369) n;
    `.execute(db)
    const { groups, truncated } = await agg('ed', {
      groupBy: { attribute: 'due', bucket: 'day' },
      measures: [{ fn: 'count' }],
    })
    expect(truncated).toBe(true)
    const days = groups.filter((g) => g.key.kind === 'value').map((g) => keys([g])[0] as string)
    expect(days).toHaveLength(366)
    expect(days).toEqual([...days].sort())
    // 374 days in all: the 8 oldest fold, the latest (the fixture's 2026-11-30) is kept.
    expect(days[0]).toBe('2025-01-09')
    expect(days.at(-1)).toBe('2026-11-30')
    expect(keys(groups).slice(-2)).toEqual(['empty', 'other'])
    expect(groups.at(-1)).toEqual({ key: { kind: 'other' }, values: [8] })
  })

  it('rounds sums and averages half away from zero, exactly, in decimal', async () => {
    // 1.005 is just below 1.005 in binary, so rounding a double would give 1.00.
    await sql`
      UPDATE attribute SET config = '{"decimals":2}' WHERE workspace_id = 'w1' AND id = 'pts'
    `.execute(db)
    const half = await create({ title: 'Half', pts: 1.005 }, 'r1')
    expect(half.values['pts']).toBe(1.005)
    const { groups } = await agg('ed', {
      where: { attribute: 'title', op: 'eq', value: 'Half' },
      measures: [
        { fn: 'sum', attribute: 'pts' },
        { fn: 'avg', attribute: 'pts' },
      ],
    })
    expect(groups[0]?.values).toEqual([1.01, 1.01])
  })

  it('agrees with POST /query on a filter with every operator, negated ones included', async () => {
    const where: Filter = {
      and: [
        {
          or: [
            { attribute: 'stage', op: 'neq', value: 'done' },
            { attribute: 'pts', op: 'is_empty' },
          ],
        },
        { attribute: 'tags', op: 'not_in', value: ['c'] },
        { attribute: 'title', op: 'not_contains', value: 'z' },
        { attribute: 'due', op: 'lt', value: '2026-12-01' },
      ],
    }
    const query = await call('ed', 'POST', '/query', { from: 'f1', where, limit: 50, count: true })
    const total = itemQueryResultSchema.parse(query.json()).total
    const [all] = (await agg('ed', { where, measures: [{ fn: 'count' }] })).groups
    expect(all?.values).toEqual([total])
    expect(total).toBe(2)
  })

  it('takes 40 conditions in all, and refuses a 41st with 400', async () => {
    const ten: { and: Filter[] } = {
      and: Array.from({ length: 10 }, () => ({ attribute: 'pts', op: 'gte', value: 0 })),
    }
    const measures = (n: number) => Array.from({ length: n }, () => ({ fn: 'count', where: ten }))
    const ok = await agg('ed', { where: ten, measures: measures(3) })
    expect(ok.groups[0]?.values).toEqual([5, 5, 5])
    const over = await call('ed', 'POST', '/aggregate', {
      from: 'f1',
      where: {
        and: [...ten.and, { attribute: 'pts', op: 'gte', value: 0 }],
      },
      measures: measures(3),
    })
    expect(over.statusCode).toBe(400)
  })

  it('refuses what the folder can’t group or summarise, with every problem listed', async () => {
    const res = await call('ed', 'POST', '/aggregate', {
      from: 'f1',
      groupBy: { attribute: 'notes' },
      measures: [
        { fn: 'sum', attribute: 'stage' },
        { fn: 'count', attribute: 'gone' },
      ],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toEqual([
      'groupBy.attribute',
      'measures.0.fn',
      'measures.1.attribute',
    ])
  })

  it('reads only what the caller may: 404 without a grant, nothing from other folders or hubs', async () => {
    expect(
      (await call('none', 'POST', '/aggregate', { from: 'f1', measures: [{ fn: 'count' }] }))
        .statusCode,
    ).toBe(404)
    expect(
      (await call('ed', 'POST', '/aggregate', { from: 'h2', measures: [{ fn: 'count' }] }))
        .statusCode,
    ).toBe(404)
    expect((await agg('vw', { measures: [{ fn: 'count' }] })).groups[0]?.values).toEqual([6])
    expect(
      (await agg('own', { from: 'h1', measures: [{ fn: 'count' }] })).groups[0]?.values,
    ).toEqual([1])
  })
})

describe('$me and $now in reads (D79, D81)', () => {
  beforeEach(async () => {
    await seed()
    await start()
    await seedItems()
  })

  it('resolves $me to the caller, in /query and /aggregate', async () => {
    const where = { attribute: 'owner', op: 'in', value: [{ $me: true }] }
    for (const [who, n] of [
      ['own', 3],
      ['ed', 2],
      ['vw', 0],
    ] as const) {
      expect((await agg(who, { where, measures: [{ fn: 'count' }] })).groups[0]?.values).toEqual([
        n,
      ])
      const res = await call(who, 'POST', '/query', { from: 'f1', where, limit: 10, count: true })
      expect(itemQueryResultSchema.parse(res.json()).total, who).toBe(n)
    }
  })

  it('resolves $now with the database clock, as a date in the request’s zone', async () => {
    // Kiritimati (UTC+14) and Pago Pago (UTC-11) are always on different calendar dates.
    const { rows } = await sql<{ east: string; west: string }>`
      SELECT to_char(now() AT TIME ZONE 'Pacific/Kiritimati', 'YYYY-MM-DD') AS east,
             to_char(now() AT TIME ZONE 'Pacific/Pago_Pago', 'YYYY-MM-DD') AS west
    `.execute(db)
    const { east, west } = rows[0] ?? { east: '', west: '' }
    await create({ title: 'today east', due: east }, 'east')
    // Today may also be another item's due date, so the item is named too.
    const where = {
      and: [
        { attribute: 'due', op: 'eq', value: { $now: 'P0D' } },
        { attribute: 'title', op: 'eq', value: 'today east' },
      ],
    }
    const count = async (tz: string) =>
      (await agg('ed', { where, measures: [{ fn: 'count' }], tz })).groups[0]?.values[0]
    expect(await count('Pacific/Kiritimati')).toBe(1)
    expect(await count('Pacific/Pago_Pago')).toBe(east === west ? 1 : 0)
    const page = await call('ed', 'POST', '/query', {
      from: 'f1',
      where,
      limit: 5,
      tz: 'Pacific/Kiritimati',
    })
    expect(itemQueryResultSchema.parse(page.json()).items.map((i) => i.id)).toEqual(['east'])
    // With time: the instant. Everything in `at` is in the past.
    const past = { attribute: 'at', op: 'lt', value: { $now: '-PT1M' } }
    expect(
      (await agg('ed', { where: past, measures: [{ fn: 'count' }] })).groups[0]?.values,
    ).toEqual([3])
  })

  it('answers 422 for an unknown zone and 400 for $block or a misplaced operand', async () => {
    const unknown = await call('ed', 'POST', '/aggregate', {
      from: 'f1',
      measures: [{ fn: 'count' }],
      tz: 'Mars/Olympus',
    })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json()).toMatchObject({ error: 'invalid_time_zone' })
    const q = await call('ed', 'POST', '/query', { from: 'f1', limit: 1, tz: 'Mars/Olympus' })
    expect(q.statusCode).toBe(422)
    for (const where of [
      { attribute: 'rel', op: 'in', value: [{ $block: 'b' }] },
      { attribute: 'stage', op: 'in', value: [{ $me: true }] },
      { attribute: 'pts', op: 'gt', value: { $now: 'P1D' } },
    ]) {
      const a = await call('ed', 'POST', '/aggregate', {
        from: 'f1',
        where,
        measures: [{ fn: 'count' }],
      })
      expect(a.statusCode, JSON.stringify(where)).toBe(400)
      const b = await call('ed', 'POST', '/query', { from: 'f1', where, limit: 1 })
      expect(b.statusCode, JSON.stringify(where)).toBe(400)
    }
  })
})

describe('aggregate timeout and budget', () => {
  it('answers 503 timeout past its statement timeout', async () => {
    await seed()
    await start({ aggregateTimeoutMs: 1 })
    // Enough rows that the statement can't finish within a millisecond.
    await sql`
      INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
      SELECT 'w1', 'g' || n, 'h1', 'f1', n, jsonb_build_object('pts', n), 'own'
      FROM generate_series(1, 20000) n;
      INSERT INTO item_index (workspace_id, attribute_id, item_id, num)
      SELECT 'w1', 'pts', 'g' || n, n FROM generate_series(1, 20000) n;
    `.execute(db)
    const res = await call('ed', 'POST', '/aggregate', {
      from: 'f1',
      groupBy: { attribute: 'owner' },
      measures: [
        { fn: 'sum', attribute: 'pts' },
        { fn: 'avg', attribute: 'pts' },
      ],
    })
    expect(res.statusCode, res.body).toBe(503)
    expect(res.json()).toMatchObject({ error: 'timeout' })
  })

  it('answers a group and 5 measures on a 2,000-item hub in under 200 ms (D80)', async () => {
    await applyLargeSeed(db, { items: 2_000 })
    await sql`
      INSERT INTO principal (workspace_id, id, kind, name, workspace_role)
        VALUES (${sql.lit(LARGE_WORKSPACE.id)}, 'agg-editor', 'user', 'Editor', 'member');
      INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role)
        VALUES (${sql.lit(LARGE_WORKSPACE.id)}, 'large', 'agg-editor', 'editor');
      ANALYZE;
    `.execute(db)
    await app.close()
    app = buildApp({ db: appDb })
    const headers = { cookie: (await sessionCookie(db, 'agg-editor')).cookie }
    const body = {
      from: LARGE_FOLDER.id,
      groupBy: { attribute: LARGE_ATTR.stage },
      measures: [
        { fn: 'count' },
        { fn: 'sum', attribute: LARGE_ATTR.effort },
        { fn: 'count', where: { attribute: LARGE_ATTR.tags, op: 'in', value: ['api'] } },
        {
          fn: 'avg',
          attribute: LARGE_ATTR.effort,
          where: { attribute: LARGE_ATTR.due, op: 'lt', value: { $now: 'P0D' } },
        },
        { fn: 'count_empty', attribute: LARGE_ATTR.due },
      ],
    }
    const run = async () => {
      const started = performance.now()
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${LARGE_WORKSPACE.id}/aggregate`,
        headers,
        payload: body,
      })
      const ms = performance.now() - started
      expect(res.statusCode, res.body).toBe(200)
      return ms
    }
    await run()
    const ms = Math.min(await run(), await run(), await run())
    console.info(`aggregate, 2,000 items: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(200)
  }, 60_000)
})
