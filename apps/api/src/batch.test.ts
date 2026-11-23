import {
  batchResponseSchema,
  type BatchOperation,
  type BatchResult,
  type HubRole,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'

// Batch writes (D65, #202): `POST /items/batch` against a real Postgres under row-level
// security. Each operation answers as its single-item route would; one failure fails only that
// operation; a malformed body fails the whole batch; a retry is safe; relation values may name
// items by key, including ones created earlier in the batch.

const WS = 'w1'
const PEOPLE = ['own', 'ed', 'vw', 'none'] as const

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
const cookies = new Map<string, string>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  for (const p of PEOPLE) cookies.set(p, (await sessionCookie(db, p)).cookie)
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * Hub h1 (folder f1) shows `t` (text, indexed), `n` (number, indexed), `rel` (relation into h1,
 * several) and `xrel` (relation into h2, cross-hub). Hub h2 shows `t2`. `own` is hub admin of
 * both, `ed` an editor of both, `vw` a viewer of h1, `none` holds no grant.
 */
async function seed(): Promise<void> {
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'W');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'own', 'owner'), ('w1', 'ed', 'user', 'ed', 'member'),
      ('w1', 'vw', 'user', 'vw', 'member'), ('w1', 'none', 'user', 'none', 'member');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'h1', 'blue', 'ONE'), ('w1', 'h2', 'h2', NULL, 'h2', 'red', 'TWO');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
      VALUES ('w1', 'f1', 'h1', 'h1', 'f1', 'blue', 'ONE');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, config, indexed) VALUES
      ('w1', 't', 'h1', 'T', 'text', '{}', true),
      ('w1', 'n', 'h1', 'N', 'number', '{}', true),
      ('w1', 'rel', 'h1', 'Rel', 'relation', '{"targetHubId":"h1","multiple":true}', false),
      ('w1', 'xrel', 'h1', 'XRel', 'relation',
        '{"targetHubId":"h2","crossHub":true,"multiple":true}', false),
      ('w1', 't2', 'h2', 'T2', 'text', '{}', true);
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position) VALUES
      ('w1', 'h1', 'f1', 't', 0), ('w1', 'h1', 'f1', 'n', 1), ('w1', 'h1', 'f1', 'rel', 2),
      ('w1', 'h1', 'f1', 'xrel', 3), ('w1', 'h2', 'h2', 't2', 0);
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
      grant('h2', 'ed', 'editor'),
      grant('h1', 'vw', 'viewer'),
    ])
    .execute()
}

const as = (who: string, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url: `/v1/workspaces/${WS}${url}`,
    headers: { cookie: cookies.get(who) ?? '' },
    ...(payload !== undefined && { payload }),
  })

async function batch(who: string, operations: BatchOperation[]): Promise<BatchResult[]> {
  const res = await as(who, 'POST', '/items/batch', { operations })
  expect(res.statusCode, res.body).toBe(200)
  return batchResponseSchema.parse(res.json()).results
}

const statuses = (results: BatchResult[]) => results.map((r) => r.status)
const errorCode = (r: BatchResult | undefined) =>
  r && 'error' in r ? r.error.error : `no error (${String(r?.status)})`
const itemOf = (r: BatchResult | undefined) => {
  if (!r || !('item' in r)) throw new Error(`no item in ${JSON.stringify(r)}`)
  return r.item
}

const itemRows = () =>
  db
    .selectFrom('item')
    .select(['id', 'external_key', 'version', 'values'])
    .where('workspace_id', '=', WS)
    .orderBy('seq_id')
    .execute()
const revisionCount = async () =>
  Number(
    (
      await db
        .selectFrom('revision')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  )
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('POST /items/batch', () => {
  it('runs every operation in order, each answering as its route would', async () => {
    await batch('ed', [{ op: 'create', id: 'a', folderId: 'f1', values: { t: 'A', n: 1 } }])
    const results = await batch('ed', [
      { op: 'create', id: 'b', folderId: 'f1', values: { t: 'B' } },
      // Stale version: 409 with the item as it is.
      { op: 'patch', id: 'a', version: 9, values: { t: 'x' } },
      // Not a number: 422, naming the attribute.
      { op: 'create', folderId: 'f1', values: { n: 'many' } },
      { op: 'patch', id: 'a', version: 1, values: { n: 2 } },
      // Its condition doesn't hold: 412, nothing written.
      {
        op: 'patch',
        id: 'b',
        version: 1,
        values: { t: 'y' },
        condition: { attribute: 'n', op: 'gt', value: 5 },
      },
      { op: 'patch', id: 'missing', version: 1, values: { t: 'x' } },
      { op: 'upsert', hubId: 'h1', key: 'k', folderId: 'f1', values: { t: 'K' } },
      { op: 'upsert', hubId: 'h1', key: 'k', folderId: 'f1', values: { n: 3 } },
      { op: 'delete', id: 'b', version: 1 },
      { op: 'create', id: 'a', folderId: 'f1' },
    ])
    expect(statuses(results)).toEqual([201, 409, 422, 200, 412, 404, 201, 200, 204, 409])
    expect(errorCode(results[1])).toBe('conflict')
    expect(results[1]).toMatchObject({ error: { current: { id: 'a', version: 1 } } })
    expect(results[2]).toMatchObject({
      error: { error: 'invalid_values', errors: [{ attributeId: 'n' }] },
    })
    expect(errorCode(results[4])).toBe('precondition_failed')
    expect(errorCode(results[9])).toBe('id_taken')
    expect(itemOf(results[3])).toMatchObject({ id: 'a', version: 2, values: { t: 'A', n: 2 } })

    // Each success carries its own revision's seq, in order.
    const seqs = results.flatMap((r) => ('item' in r ? [r.item.seq] : 'seq' in r ? [r.seq] : []))
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(seqs.length)
    const changes = await as('own', 'GET', `/changes?after=${String((seqs[0] ?? 1) - 1)}&limit=50`)
    expect(changes.statusCode).toBe(200)

    expect(await itemRows()).toEqual([
      { id: 'a', external_key: null, version: 2, values: { t: 'A', n: 2 } },
      expect.objectContaining({ external_key: 'k', version: 2, values: { t: 'K', n: 3 } }),
    ])
  })

  it('refuses a malformed batch whole, with the operation named, and writes nothing', async () => {
    const before = await workspaceSnapshot(db, WS)
    const bodies: [unknown, RegExp][] = [
      [{ operations: [] }, /operations/],
      [
        {
          operations: [
            { op: 'create', folderId: 'f1', values: { t: 'ok' } },
            { op: 'patch', id: 'a', values: { t: 'no version' } },
          ],
        },
        /operations\.1/,
      ],
      [{ operations: [{ op: 'move', id: 'a' }] }, /operations\.0/],
      [
        {
          operations: [
            { op: 'create', folderId: 'f1', clientMutationId: uuid(1) },
            { op: 'create', folderId: 'f1', clientMutationId: uuid(1) },
          ],
        },
        /operations\.1\.clientMutationId/,
      ],
      [
        { operations: Array.from({ length: 101 }, () => ({ op: 'create', folderId: 'f1' })) },
        /operations/,
      ],
    ]
    for (const [body, path] of bodies) {
      const res = await as('ed', 'POST', '/items/batch', body as object)
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json()).toMatchObject({
        error: 'invalid_request',
        message: expect.stringMatching(path) as string,
      })
    }
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('is safe to retry whole: every operation answers as the first time, writing nothing', async () => {
    await batch('ed', [{ op: 'create', id: 'old', folderId: 'f1', values: { t: 'Old' } }])
    const operations: BatchOperation[] = [
      { op: 'create', id: 'a', folderId: 'f1', values: { t: 'A' }, clientMutationId: uuid(1) },
      { op: 'patch', id: 'a', version: 1, values: { n: 1 }, clientMutationId: uuid(2) },
      { op: 'upsert', hubId: 'h1', key: 'k', folderId: 'f1', clientMutationId: uuid(3) },
      { op: 'delete', id: 'old', version: 1, clientMutationId: uuid(4) },
      // Failed conditions record nothing, so they are evaluated again.
      {
        op: 'patch',
        id: 'a',
        version: 2,
        values: { t: 'B' },
        condition: { attribute: 'n', op: 'gt', value: 5 },
        clientMutationId: uuid(5),
      },
    ]
    const first = await batch('ed', operations)
    expect(statuses(first)).toEqual([201, 200, 201, 204, 412])
    const rows = await itemRows()
    const revisions = await revisionCount()

    const again = await batch('ed', operations)
    expect(statuses(again)).toEqual([201, 200, 201, 204, 412])
    // The delete answers its first attempt's seq; the writes the item as it is now.
    expect(again[3]).toEqual(first[3])
    expect(itemOf(again[0])).toMatchObject({ id: 'a', version: 2, values: { t: 'A', n: 1 } })
    expect(itemOf(again[1])).toMatchObject({ id: 'a', version: 2 })
    expect(itemOf(again[2]).id).toBe(itemOf(first[2]).id)
    expect(await itemRows()).toEqual(rows)
    expect(await revisionCount()).toBe(revisions)

    // The same ID with another operation is that operation's 422, not the batch's.
    const reused = await batch('ed', [
      { op: 'create', folderId: 'f1', clientMutationId: uuid(2) },
      { op: 'create', id: 'c', folderId: 'f1' },
    ])
    expect(statuses(reused)).toEqual([422, 201])
    expect(errorCode(reused[0])).toBe('mutation_id_reused')
  })

  it('resolves relation values by key in the hub, including items created earlier in the batch', async () => {
    const results = await batch('ed', [
      { op: 'upsert', hubId: 'h1', key: 'epic', folderId: 'f1', values: { t: 'Epic' } },
      {
        op: 'create',
        id: 'task',
        folderId: 'f1',
        externalKey: 'task',
        values: { t: 'Task', rel: [{ externalKey: 'epic' }] },
      },
      // A key no item holds fails this operation only.
      { op: 'create', folderId: 'f1', values: { rel: [{ externalKey: 'nope' }] } },
      // IDs and keys mix; the order is kept.
      {
        op: 'patch',
        id: 'task',
        version: 1,
        values: { rel: [{ externalKey: 'epic' }, 'task'] },
      },
      {
        op: 'upsert',
        hubId: 'h1',
        key: 'other',
        folderId: 'f1',
        values: { rel: [{ externalKey: 'task' }] },
      },
      // A cross-hub relation takes item IDs only (#250).
      { op: 'create', folderId: 'f1', values: { xrel: [{ externalKey: 'epic' }] } },
    ])
    expect(statuses(results)).toEqual([201, 201, 422, 200, 201, 422])
    const epic = itemOf(results[0]).id
    expect(itemOf(results[1]).values).toEqual({ t: 'Task', rel: [epic] })
    expect(results[2]).toMatchObject({
      error: {
        error: 'invalid_values',
        errors: [{ attributeId: 'rel', message: expect.stringContaining('"nope"') as string }],
      },
    })
    expect(itemOf(results[3]).values['rel']).toEqual([epic, 'task'])
    expect(itemOf(results[4]).values['rel']).toEqual(['task'])
    expect(results[5]).toMatchObject({ error: { errors: [{ attributeId: 'xrel' }] } })
    const links = await db
      .selectFrom('link')
      .select(['from_item', 'to_item'])
      .orderBy('from_item')
      .orderBy('to_item')
      .execute()
    expect(links).toEqual(
      [
        { from_item: itemOf(results[4]).id, to_item: 'task' },
        { from_item: 'task', to_item: epic },
        { from_item: 'task', to_item: 'task' },
      ].sort((x, y) => (x.from_item + x.to_item).localeCompare(y.from_item + y.to_item)),
    )

    // The single-item routes take item IDs only.
    const single = await as('ed', 'POST', '/items', {
      folderId: 'f1',
      values: { rel: [{ externalKey: 'epic' }] },
    })
    expect(single.statusCode).toBe(422)
  })

  it('checks each operation as its route does, per role', async () => {
    await batch('own', [{ op: 'create', id: 'a', folderId: 'f1', values: { t: 'A' } }])
    const operations: BatchOperation[] = [
      { op: 'create', folderId: 'f1', values: { t: 'x' } },
      { op: 'patch', id: 'a', version: 1, values: { t: 'x' } },
      { op: 'upsert', hubId: 'h1', key: 'k', folderId: 'f1' },
      { op: 'delete', id: 'a', version: 1 },
    ]
    // A viewer can't write: 403 on what it can read.
    expect(statuses(await batch('vw', operations))).toEqual([403, 403, 403, 403])
    // No grant: everything is hidden, so 404.
    expect(statuses(await batch('none', operations))).toEqual([404, 404, 404, 404])
    expect((await itemRows()).map((r) => r.id)).toEqual(['a'])
  })
})

describe('batch performance (D75)', () => {
  it('writes 100 operations while 15 readers poll, without starving them', async () => {
    const operations: BatchOperation[] = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0
        ? { op: 'create', folderId: 'f1', values: { t: `Item ${String(i)}`, n: i } }
        : { op: 'upsert', hubId: 'h1', key: `k${String(i)}`, folderId: 'f1', values: { n: i } },
    )
    let done = false
    const polls = Array.from({ length: 15 }, () => 0)
    const readers = polls.map(async (_, r) => {
      while (!done) {
        const res = await as('vw', 'POST', '/query', { from: 'f1', limit: 50, order: 'number' })
        expect(res.statusCode).toBe(200)
        polls[r] = (polls[r] ?? 0) + 1
      }
    })
    const started = performance.now()
    const results = await batch('ed', operations)
    const elapsed = performance.now() - started
    done = true
    await Promise.all(readers)

    expect(results.every((r) => r.status === 201)).toBe(true)
    expect((await itemRows()).length).toBe(100)
    // Every reader kept being answered while the batch ran.
    expect(Math.min(...polls)).toBeGreaterThan(0)
    console.info(
      `batch of 100 with 15 readers: ${elapsed.toFixed(0)} ms, polls per reader ${String(Math.min(...polls))}–${String(Math.max(...polls))}`,
    )
    expect(elapsed).toBeLessThan(10_000)
  }, 60_000)
})
