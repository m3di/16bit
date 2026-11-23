import { batchResponseSchema, type HubRole } from '@16bit/core'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'

// U+0000 end to end (#221): Postgres can't store it in `text` or `jsonb`, so every write path
// must refuse it with 400 or 422 before the database does, and never answer 500. Item values
// are 422 `invalid_values` (core's value schemas); causes, keys and filters 400
// `invalid_request` (core's request schemas); anything else Postgres refuses for a NUL (names
// in hub settings) is mapped to 400 by the app's error handler. Nothing is written.

const WS = 'w1'
const NUL = 'a\u0000b'

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let cookie = ''

// Read-only tests and writes that are refused: one database for the file.
beforeAll(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await sql`
    INSERT INTO workspace (id, name) VALUES ('w1', 'W');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('w1', 'own', 'user', 'own', 'owner');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix) VALUES
      ('w1', 'h1', 'h1', NULL, 'h1', 'blue', 'ONE');
    INSERT INTO attribute (workspace_id, id, hub_id, name, type, config, indexed) VALUES
      ('w1', 't', 'h1', 'T', 'text', '{}', true),
      ('w1', 'u', 'h1', 'U', 'url', '{}', true),
      ('w1', 'doc', 'h1', 'Doc', 'rich_text', '{}', false),
      ('w1', 'rel', 'h1', 'Rel', 'relation', '{"targetHubId":"h1","multiple":true}', false),
      ('w1', 's', 'h1', 'S', 'select', '{"options":[{"id":"x","label":"X"}]}', true);
    INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position) VALUES
      ('w1', 'h1', 'h1', 't', 0), ('w1', 'h1', 'h1', 'u', 1), ('w1', 'h1', 'h1', 'doc', 2),
      ('w1', 'h1', 'h1', 'rel', 3), ('w1', 'h1', 'h1', 's', 4);
  `.execute(db)
  const grant: { workspace_id: string; hub_id: string; principal_id: string; hub_role: HubRole } = {
    workspace_id: WS,
    hub_id: 'h1',
    principal_id: 'own',
    hub_role: 'hub_admin',
  }
  await db.insertInto('hub_grant').values(grant).execute()
  cookie = (await sessionCookie(db, 'own')).cookie
  app = buildApp({ db: appDb })
  const created = await as('POST', '/items', {
    id: 'i1',
    folderId: 'h1',
    externalKey: 'k1',
    values: { t: 'one' },
  })
  expect(created.statusCode, created.body).toBe(201)
}, 60_000)

afterAll(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

const as = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url: `/v1/workspaces/${WS}${url}`,
    headers: { cookie },
    ...(payload !== undefined && { payload }),
  })

/** The answer is `status` with `error`, and the workspace is as it was before the request. */
async function refused(
  request: () => Promise<LightMyRequestResponse>,
  status: number,
  error: string,
): Promise<LightMyRequestResponse> {
  const before = await workspaceSnapshot(db, WS)
  const res = await request()
  expect(res.statusCode, res.body).toBe(status)
  expect(res.json()).toMatchObject({ error })
  expect(await workspaceSnapshot(db, WS)).toEqual(before)
  return res
}

const richText = (text: string, href?: string) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text,
          ...(href !== undefined && { marks: [{ type: 'link', attrs: { href } }] }),
        },
      ],
    },
  ],
})

/** Item values holding a NUL, one per type that stores text. */
const BAD_VALUES: [string, Record<string, unknown>][] = [
  ['text', { t: NUL }],
  ['url', { u: `https://example.com/${NUL}` }],
  ['rich text', { doc: richText(NUL) }],
  ['rich text link', { doc: richText('x', `https://example.com/${NUL}`) }],
]

const BAD_CAUSES: [string, object][] = [
  ['note', { note: NUL }],
  ['evidence', { evidence: [`https://example.com/${NUL}`] }],
]

describe('item values with U+0000 answer 422 invalid_values on every write path', () => {
  for (const [name, values] of BAD_VALUES) {
    it(name, async () => {
      await refused(() => as('POST', '/items', { folderId: 'h1', values }), 422, 'invalid_values')
      await refused(() => as('PATCH', '/items/i1', { version: 1, values }), 422, 'invalid_values')
      await refused(
        () => as('PUT', '/hubs/h1/items/by-key/new', { folderId: 'h1', values }),
        422,
        'invalid_values',
      )
      await refused(
        () => as('PUT', '/hubs/h1/items/by-key/k1', { folderId: 'h1', values }),
        422,
        'invalid_values',
      )
    })
  }

  it('in a batch, each operation answers 422 and the others are untouched', async () => {
    const before = await workspaceSnapshot(db, WS)
    const res = await as('POST', '/items/batch', {
      operations: BAD_VALUES.flatMap(([, values]) => [
        { op: 'create', folderId: 'h1', values },
        { op: 'patch', id: 'i1', version: 1, values },
        { op: 'upsert', hubId: 'h1', key: 'new', folderId: 'h1', values },
      ]),
    })
    expect(res.statusCode, res.body).toBe(200)
    const { results } = batchResponseSchema.parse(res.json())
    expect(results.map((r) => r.status)).toEqual(results.map(() => 422))
    for (const r of results) expect(r).toMatchObject({ error: { error: 'invalid_values' } })
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })
})

describe('causes, keys and filters with U+0000 answer 400 invalid_request', () => {
  for (const [name, cause] of BAD_CAUSES) {
    it(`a cause ${name}, on every write path`, async () => {
      const values = { t: 'fine' }
      await refused(
        () => as('POST', '/items', { folderId: 'h1', values, cause }),
        400,
        'invalid_request',
      )
      await refused(
        () => as('PATCH', '/items/i1', { version: 1, values, cause }),
        400,
        'invalid_request',
      )
      await refused(() => as('DELETE', '/items/i1?version=1', { cause }), 400, 'invalid_request')
      await refused(
        () => as('PUT', '/hubs/h1/items/by-key/k1', { folderId: 'h1', values, cause }),
        400,
        'invalid_request',
      )
      for (const op of [
        { op: 'create', folderId: 'h1', values, cause },
        { op: 'patch', id: 'i1', version: 1, values, cause },
        { op: 'upsert', hubId: 'h1', key: 'k1', folderId: 'h1', values, cause },
        { op: 'delete', id: 'i1', version: 1, cause },
      ]) {
        await refused(
          () => as('POST', '/items/batch', { operations: [op] }),
          400,
          'invalid_request',
        )
      }
    })
  }

  it('an external key, in the body, the path and a relation reference', async () => {
    await refused(
      () => as('POST', '/items', { folderId: 'h1', externalKey: NUL, values: {} }),
      400,
      'invalid_request',
    )
    await refused(
      () => as('PATCH', '/items/i1', { version: 1, externalKey: NUL }),
      400,
      'invalid_request',
    )
    await refused(
      () => as('PUT', '/hubs/h1/items/by-key/a%00b', { folderId: 'h1', values: {} }),
      400,
      'invalid_request',
    )
    await refused(() => as('GET', '/hubs/h1/items/by-key/a%00b'), 400, 'invalid_request')
    // A reference that names no key is the operation's own invalid value (D65).
    const before = await workspaceSnapshot(db, WS)
    const res = await as('POST', '/items/batch', {
      operations: [{ op: 'create', folderId: 'h1', values: { rel: [{ externalKey: NUL }] } }],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(batchResponseSchema.parse(res.json()).results).toMatchObject([
      { status: 422, error: { error: 'invalid_values' } },
    ])
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
  })

  it('a text filter or condition operand', async () => {
    for (const op of ['eq', 'contains', 'starts_with']) {
      await refused(
        () => as('POST', '/query', { from: 'h1', where: { attribute: 't', op, value: NUL } }),
        400,
        'invalid_request',
      )
    }
    const res = await as('PATCH', '/items/i1', {
      version: 1,
      values: { t: 'two' },
      condition: { attribute: 't', op: 'eq', value: NUL },
    })
    expect([400, 422], res.body).toContain(res.statusCode)
    expect(
      (
        await db
          .selectFrom('item')
          .select('version')
          .where('id', '=', 'i1')
          .executeTakeFirstOrThrow()
      ).version,
    ).toBe(1)
  })
})

describe('names in hub settings with U+0000 answer 400, never 500', () => {
  it('hub, folder, attribute and option names', async () => {
    const hub = { name: NUL, color: 'blue', idPrefix: 'NUL' }
    await refused(() => as('POST', '/hubs', hub), 400, 'invalid_request')
    await refused(() => as('PATCH', '/hubs/h1', { version: 0, name: NUL }), 400, 'invalid_request')
    await refused(
      () => as('POST', '/hubs/h1/folders', { parentId: 'h1', name: NUL, color: 'blue' }),
      400,
      'invalid_request',
    )
    await refused(
      () => as('POST', '/hubs/h1/attributes', { name: NUL, type: 'text', config: {} }),
      400,
      'invalid_request',
    )
    await refused(
      () =>
        as('POST', '/hubs/h1/attributes', {
          name: 'Sel',
          type: 'select',
          config: { options: [{ label: NUL }] },
        }),
      400,
      'invalid_request',
    )
    await refused(
      () => as('PATCH', '/attributes/t', { version: 0, name: NUL }),
      400,
      'invalid_request',
    )
    await refused(
      () => as('POST', '/hubs/h1/agent-keys', { name: NUL, hubRole: 'editor' }),
      400,
      'invalid_request',
    )
  })
})
