import {
  attributeTypes,
  indexEntries,
  validateItemValues,
  type AttributeTypeName,
  type FolderAttributeDefinition,
} from '@16bit/core'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'
import { DEV_OWNER, DEV_PASSWORD } from './dev-accounts.ts'
import { createItem, deleteItem, folderDefinitions } from './items.ts'
import {
  applyLargeSeed,
  ensureLargeHub,
  LARGE_ATTR,
  LARGE_FOLDER,
  LARGE_HUB,
  LARGE_WORKSPACE,
  largeItemId,
} from './large-seed.ts'

// Integration tests against a fresh, migrated Postgres per test, with a few hundred items in
// small chunks instead of 50,000. LARGE_SEED_FULL=1 also runs the full seed against its
// one-minute budget.

const WS = LARGE_WORKSPACE.id

let db: Kysely<Database>
let appUrl: string
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  appUrl = test.appUrl
  db = createDb(test.url)
  await migrateToLatest(db)
})

afterEach(async () => {
  await db.destroy()
  await drop()
})

const folderRow = (id: string) =>
  db
    .selectFrom('folder')
    .selectAll()
    .where('workspace_id', '=', WS)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

const links = () =>
  db
    .selectFrom('link')
    .select(['from_item', 'attribute_id', 'to_item'])
    .where('workspace_id', '=', WS)
    .orderBy('from_item')
    .orderBy('attribute_id')
    .orderBy('to_item')
    .execute()

/**
 * Every invariant `createItem` keeps, checked over the whole workspace: counters, item numbers,
 * auto IDs, one create revision per item with contiguous `seq`, item_index and link rows exactly
 * as the values project, and values that pass the core contract.
 */
async function expectConsistent(): Promise<void> {
  const definitions = await folderDefinitions(db, WS, LARGE_FOLDER.id)
  const items = await db
    .selectFrom('item')
    .selectAll()
    .where('workspace_id', '=', WS)
    .orderBy('seq_id')
    .execute()
  const hub = await folderRow(LARGE_HUB.id)
  const folder = await folderRow(LARGE_FOLDER.id)
  expect(hub.item_count).toBe(items.length)
  expect(folder.item_count).toBe(items.filter((i) => i.folder_id === LARGE_FOLDER.id).length)
  expect(new Set(items.map((i) => i.seq_id)).size).toBe(items.length)
  expect(hub.next_seq).toBeGreaterThan(Math.max(0, ...items.map((i) => i.seq_id)))

  const writable = definitions.filter((d) => !attributeTypes[d.attribute.type].readOnly)
  for (const item of items) {
    expect(item.values[LARGE_ATTR.key]).toBe(item.seq_id)
    const rest = Object.fromEntries(
      Object.entries(item.values).filter(([id]) => id !== LARGE_ATTR.key),
    )
    const result = validateItemValues(writable, rest, { partial: false })
    expect(result.ok, `${item.id}: ${JSON.stringify(result)}`).toBe(true)
  }

  const revisions = await db
    .selectFrom('revision')
    .selectAll()
    .where('workspace_id', '=', WS)
    .orderBy('seq')
    .execute()
  const ws = await db
    .selectFrom('workspace')
    .select('next_revision_seq')
    .where('id', '=', WS)
    .executeTakeFirstOrThrow()
  expect(revisions.map((r) => r.seq)).toEqual(revisions.map((_, i) => i + 1))
  expect(ws.next_revision_seq).toBe(revisions.length + 1)
  const creates = new Map(
    revisions.filter((r) => r.patch['op'] === 'create').map((r) => [r.item_id, r]),
  )
  for (const item of items) {
    const revision = creates.get(item.id)
    expect(revision, item.id).toBeDefined()
    if (item.updated_by === DEV_OWNER.id && item.version === 1) {
      expect(revision?.patch).toEqual({
        op: 'create',
        folderId: item.folder_id,
        values: item.values,
      })
      expect(revision?.hub_id).toBe(LARGE_HUB.id)
    }
  }

  const expectedIndex = items
    .flatMap((item) =>
      definitions
        .filter((d) => d.attribute.indexed)
        .flatMap(({ attribute }) =>
          indexEntries(attribute, item.values[attribute.id] ?? null).map(
            (e) => `${item.id}|${attribute.id}|${String(e.ord)}|${e.column}|${String(e.value)}`,
          ),
        ),
    )
    .sort()
  const indexRows = await db
    .selectFrom('item_index')
    .selectAll()
    .where('workspace_id', '=', WS)
    .execute()
  const actualIndex = indexRows
    .map((r) => {
      const [column, value] =
        r.num !== null
          ? ['num', String(r.num)]
          : r.txt !== null
            ? ['txt', r.txt]
            : ['ts', (r.ts as Date).toISOString()]
      return `${r.item_id}|${r.attribute_id}|${String(r.ord)}|${column}|${value}`
    })
    .sort()
  // Dates come back as timestamps: compare their instants.
  const normalise = (row: string) => {
    const parts = row.split('|')
    if (parts[3] === 'ts') parts[4] = new Date(parts[4] ?? '').toISOString()
    return parts.join('|')
  }
  expect(actualIndex.map(normalise)).toEqual(expectedIndex.map(normalise))

  const relations = definitions.filter((d) => d.attribute.type === 'relation')
  const expectedLinks = items
    .flatMap((item) =>
      relations.flatMap(({ attribute }) => {
        const value = item.values[attribute.id]
        return Array.isArray(value)
          ? value.map((to) => ({
              from_item: item.id,
              attribute_id: attribute.id,
              to_item: to,
            }))
          : []
      }),
    )
    .sort((a, b) =>
      `${a.from_item}|${a.attribute_id}|${a.to_item}`.localeCompare(
        `${b.from_item}|${b.attribute_id}|${b.to_item}`,
      ),
    )
  expect(await links()).toEqual(expectedLinks)
}

describe('applyLargeSeed', () => {
  it('creates the hub, its folder and items in chunks, with every M1 type and revisions', async () => {
    const result = await applyLargeSeed(db, { items: 1_200, chunk: 500 })
    expect(result).toEqual({ hubDeleted: false, created: 1_200, folderItems: 1_200 })

    const definitions: FolderAttributeDefinition[] = await folderDefinitions(
      db,
      WS,
      LARGE_FOLDER.id,
    )
    const types = new Set(definitions.map((d) => d.attribute.type))
    const m1: AttributeTypeName[] = [
      'text',
      'number',
      'boolean',
      'date',
      'select',
      'multi_select',
      'url',
      'actor',
      'auto_id',
      'rich_text',
      'relation',
    ]
    expect([...types].sort()).toEqual([...m1].sort())
    expect(definitions.filter((d) => d.attribute.indexed).length).toBeGreaterThanOrEqual(5)

    const hub = await folderRow(LARGE_HUB.id)
    expect(hub.title_attribute_id).toBe(LARGE_ATTR.title)
    expect(hub.version).toBe(0)
    expect(hub.next_seq).toBe(1_201)
    const grant = await db
      .selectFrom('hub_grant')
      .select('hub_role')
      .where('workspace_id', '=', WS)
      .where('hub_id', '=', LARGE_HUB.id)
      .where('principal_id', '=', DEV_OWNER.id)
      .executeTakeFirstOrThrow()
    expect(grant.hub_role).toBe('hub_admin')

    // Item numbers follow the IDs on a fresh run, so LRG-n is large-0000n.
    const sample = await db
      .selectFrom('item')
      .select(['id', 'seq_id', 'folder_id'])
      .where('workspace_id', '=', WS)
      .where('id', 'in', [largeItemId(1), largeItemId(777)])
      .orderBy('id')
      .execute()
    expect(sample.map((i) => [i.id, i.seq_id, i.folder_id])).toEqual([
      [largeItemId(1), 1, LARGE_FOLDER.id],
      [largeItemId(777), 777, LARGE_FOLDER.id],
    ])
    expect((await links()).length).toBeGreaterThan(0)
    await expectConsistent()
  })

  it('changes nothing on a re-run', async () => {
    await applyLargeSeed(db, { items: 600, chunk: 250 })
    const before = { ...(await workspaceSnapshot(db, WS)), links: await links() }
    const again = await applyLargeSeed(db, { items: 600, chunk: 250 })
    expect(again).toEqual({ hubDeleted: false, created: 0, folderItems: 600 })
    expect({ ...(await workspaceSnapshot(db, WS)), links: await links() }).toEqual(before)
  })

  it('tops up a partial run, keeps deleted items deleted and never links to them', async () => {
    await applyLargeSeed(db, { items: 300, chunk: 100 })
    const doomed = await db
      .selectFrom('item')
      .select(['id', 'version'])
      .where('workspace_id', '=', WS)
      .where('id', '=', largeItemId(300))
      .executeTakeFirstOrThrow()
    await deleteItem(db, WS, DEV_OWNER.id, doomed.id, doomed.version)
    // An item made through the API in between takes the next number; the seed continues after it.
    const made = await createItem(db, WS, DEV_OWNER.id, {
      folderId: LARGE_FOLDER.id,
      values: { [LARGE_ATTR.title]: 'Made in between' },
    })
    expect(made.seqId).toBe(301)

    const result = await applyLargeSeed(db, { items: 600, chunk: 100 })
    expect(result).toEqual({ hubDeleted: false, created: 300, folderItems: 600 })
    const gone = await db
      .selectFrom('item')
      .select('id')
      .where('workspace_id', '=', WS)
      .where('id', '=', largeItemId(300))
      .executeTakeFirst()
    expect(gone).toBeUndefined()
    const next = await db
      .selectFrom('item')
      .select('seq_id')
      .where('workspace_id', '=', WS)
      .where('id', '=', largeItemId(301))
      .executeTakeFirstOrThrow()
    expect(next.seq_id).toBe(302)
    expect((await links()).some((l) => l.to_item === largeItemId(300))).toBe(false)
    await expectConsistent()
  })

  it('leaves out an attribute deleted and an option removed before the run', async () => {
    await ensureLargeHub(db)
    // As the API would leave it: the attribute is gone (its tombstone written by the trigger),
    // and Stage has lost an option.
    await db
      .deleteFrom('folder_attribute')
      .where('workspace_id', '=', WS)
      .where('attribute_id', '=', LARGE_ATTR.notes)
      .execute()
    await db
      .deleteFrom('attribute')
      .where('workspace_id', '=', WS)
      .where('id', '=', LARGE_ATTR.notes)
      .execute()
    await sql`
      UPDATE attribute
      SET config = jsonb_set(config, '{options}',
        (SELECT jsonb_agg(o) FROM jsonb_array_elements(config->'options') o
         WHERE o->>'id' <> 'shipped'))
      WHERE workspace_id = ${WS} AND id = ${LARGE_ATTR.stage}
    `.execute(db)

    await applyLargeSeed(db, { items: 400, chunk: 200 })
    const attribute = await db
      .selectFrom('attribute')
      .select('id')
      .where('workspace_id', '=', WS)
      .where('id', '=', LARGE_ATTR.notes)
      .executeTakeFirst()
    expect(attribute).toBeUndefined()
    const stray = await db
      .selectFrom('item')
      .select('id')
      .where('workspace_id', '=', WS)
      .where((eb) =>
        eb.or([
          sql<boolean>`values ? ${LARGE_ATTR.notes}`,
          sql<boolean>`values->>${LARGE_ATTR.stage} = 'shipped'`,
        ]),
      )
      .execute()
    expect(stray).toEqual([])
    await expectConsistent()
  })

  it('writes nothing when the hub was deleted', async () => {
    await db.insertInto('workspace').values({ id: WS, name: 'Large folder' }).execute()
    await db
      .insertInto('principal')
      .values({
        workspace_id: WS,
        id: DEV_OWNER.id,
        kind: 'user',
        name: 'Dev Owner',
        workspace_role: 'owner',
      })
      .execute()
    await db
      .insertInto('deleted_hub')
      .values({ workspace_id: WS, id: LARGE_HUB.id, deleted_by: DEV_OWNER.id })
      .execute()
    expect(await applyLargeSeed(db, { items: 10 })).toEqual({
      hubDeleted: true,
      created: 0,
      folderItems: 0,
    })
    const folders = await db
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', WS)
      .execute()
    expect(folders).toEqual([])
    // Nothing else either: no account, and no principal besides the one already there.
    expect(await db.selectFrom('account').select('id').execute()).toEqual([])
    const principals = await db
      .selectFrom('principal')
      .select(['id', 'account_id'])
      .where('workspace_id', '=', WS)
      .execute()
    expect(principals).toEqual([{ id: DEV_OWNER.id, account_id: null }])
  })

  it('refuses an invalid item count or chunk before writing', async () => {
    await expect(applyLargeSeed(db, { items: -1 })).rejects.toThrow(/items/)
    await expect(applyLargeSeed(db, { items: 1.5 })).rejects.toThrow(/items/)
    await expect(applyLargeSeed(db, { items: 10, chunk: 0 })).rejects.toThrow(/chunk/)
    const ws = await db.selectFrom('workspace').select('id').where('id', '=', WS).execute()
    expect(ws).toEqual([])
  })

  it('is readable through the API by the dev owner, under row-level security', async () => {
    await applyLargeSeed(db, { items: 250, chunk: 100 })
    const appDb = createDb(appUrl)
    const app = buildApp({ db: appDb })
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: DEV_OWNER.email, password: DEV_PASSWORD },
      })
      expect(login.statusCode, login.body).toBe(200)
      const setCookie = login.headers['set-cookie']
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? ''
      const query = (body: object) =>
        app.inject({
          method: 'POST',
          url: `/v1/workspaces/${WS}/query`,
          headers: { cookie },
          payload: body,
        })

      const page = await query({
        from: LARGE_FOLDER.id,
        where: { and: [{ attribute: LARGE_ATTR.effort, op: 'gte', value: 0 }] },
        sort: [{ attribute: LARGE_ATTR.effort, direction: 'desc' }],
        limit: 50,
      })
      expect(page.statusCode, page.body).toBe(200)
      const body = page.json<{ items: { id: string }[]; nextCursor: string | null }>()
      expect(body.items).toHaveLength(50)
      expect(body.nextCursor).not.toBeNull()

      const missing = await query({ from: 'no-such-folder', limit: 10 })
      expect(missing.statusCode).toBe(404)
    } finally {
      await app.close()
      await appDb.destroy()
    }
  })

  it.runIf(process.env['LARGE_SEED_FULL'] === '1')(
    'creates 50,000 items in under a minute',
    async () => {
      const started = performance.now()
      const result = await applyLargeSeed(db)
      expect(result).toEqual({ hubDeleted: false, created: 50_000, folderItems: 50_000 })
      expect(performance.now() - started).toBeLessThan(60_000)
    },
    120_000,
  )
})
