import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ATTR,
  BUILD_HUB,
  BUILD_WORKSPACE,
  ensureBuildHub,
  ghIssueSchema,
  importIssues,
  IMPORT_ACTOR,
  parseIssues,
  toValues,
  type GhIssue,
} from './build-hub.ts'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { DEV_OWNER, DEV_PASSWORD } from './dev-accounts.ts'
import { verifyPassword } from './auth/password.ts'
import { workspaceSnapshot } from './db/test-snapshot.ts'
import { deleteItem, getItem, patchItem } from './items.ts'

// Integration tests against a fresh, migrated Postgres per test. `gh` is not called:
// the importer takes parsed issues, so fixtures stand in for its output.

const OWNER = DEV_OWNER.id
const WS = BUILD_WORKSPACE.id

let db: Kysely<Database>
let dbUrl: string
let appUrl: string
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  dbUrl = test.url
  appUrl = test.appUrl
  db = createDb(test.url)
  await migrateToLatest(db)
  await ensureBuildHub(db)
})

afterEach(async () => {
  await db.destroy()
  await drop()
})

const issue = (number: number, over: Partial<GhIssue> = {}): GhIssue => ({
  number,
  title: `Issue ${String(number)}`,
  state: 'OPEN',
  url: `https://github.com/m3di/16bit/issues/${String(number)}`,
  labels: [{ name: 'stage:todo' }, { name: 'role:backend' }],
  milestone: { title: 'M0' },
  ...over,
})

const hubCount = async () =>
  (
    await db
      .selectFrom('folder')
      .select('item_count')
      .where('workspace_id', '=', WS)
      .where('id', '=', BUILD_HUB.id)
      .executeTakeFirstOrThrow()
  ).item_count

/**
 * Runs `fn` against the API on the API's own role (row-level security, #44), signed in as the
 * dev owner, the Build hub's hub admin. For edits and deletes that must go the way a person's do.
 */
async function withApi(
  fn: (
    call: (method: 'PATCH' | 'DELETE', url: string, payload?: object) => Promise<number>,
  ) => Promise<void>,
): Promise<void> {
  const appDb = createDb(appUrl)
  const app: FastifyInstance = buildApp({ db: appDb })
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: DEV_OWNER.email, password: DEV_PASSWORD },
    })
    expect(login.statusCode, login.body).toBe(200)
    const setCookie = login.headers['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? ''
    await fn(async (method, url, payload) => {
      const res = await app.inject({
        method,
        url: `/v1/workspaces/${WS}${url}`,
        headers: { cookie },
        ...(payload && { payload }),
      })
      return res.statusCode
    })
  } finally {
    await app.close()
    await appDb.destroy()
  }
}

const revisions = () =>
  db.selectFrom('revision').selectAll().where('workspace_id', '=', WS).orderBy('seq').execute()

describe('toValues', () => {
  it('maps labels, milestone, and URL to attribute values', () => {
    expect(toValues(issue(11))).toEqual({
      [ATTR.title]: 'Issue 11',
      [ATTR.issue]: 11,
      [ATTR.stage]: 'todo',
      [ATTR.role]: 'backend',
      [ATTR.milestone]: 'M0',
      [ATTR.url]: 'https://github.com/m3di/16bit/issues/11',
    })
  })

  it('treats a closed issue without a stage label as done, and ignores unknown labels', () => {
    const values = toValues(
      issue(3, {
        state: 'CLOSED',
        labels: [{ name: 'bug' }, { name: 'stage:nope' }, { name: 'role:astronaut' }],
        milestone: null,
      }),
    )
    expect(values[ATTR.stage]).toBe('done')
    expect(values[ATTR.role]).toBeNull()
    expect(values[ATTR.milestone]).toBeNull()
  })

  it('keeps an open issue without a stage label empty', () => {
    expect(toValues(issue(4, { labels: [] }))[ATTR.stage]).toBeNull()
  })
})

describe('ghIssueSchema', () => {
  it('rejects malformed gh output', () => {
    expect(ghIssueSchema.safeParse({ ...issue(1), number: 'one' }).success).toBe(false)
    expect(ghIssueSchema.safeParse({ ...issue(1), title: '' }).success).toBe(false)
    expect(ghIssueSchema.safeParse({ ...issue(1), state: 'MERGED' }).success).toBe(false)
    expect(ghIssueSchema.safeParse({ ...issue(1), url: 'not a url' }).success).toBe(false)
  })

  it('ignores extra fields from gh', () => {
    expect(ghIssueSchema.safeParse({ ...issue(1), body: 'x' }).success).toBe(true)
  })
})

describe('parseIssues', () => {
  it('parses gh output', () => {
    const issues = [issue(1), { ...issue(2), body: 'extra fields are ignored' }]
    expect(parseIssues(JSON.stringify(issues))).toEqual([issue(1), issue(2)])
    expect(parseIssues('[]')).toEqual([])
  })

  it('rejects output that is not JSON', () => {
    for (const stdout of ['', 'gh: not logged in', '[{"number": 1']) {
      expect(() => parseIssues(stdout), stdout).toThrow('gh output is not JSON')
    }
  })

  it('rejects JSON that is not a list of issues, naming the bad field', () => {
    expect(() => parseIssues('{"number": 1}')).toThrow('gh output is not a list of issues')
    expect(() => parseIssues('null')).toThrow('gh output is not a list of issues')
    const badState = JSON.stringify([issue(1), { ...issue(2), state: 'MERGED' }])
    expect(() => parseIssues(badState)).toThrow('[1.state]')
    const noLabels = JSON.stringify([{ ...issue(1), labels: undefined }])
    expect(() => parseIssues(noLabels)).toThrow('[0.labels]')
  })

  it('rejects an issue listed twice', () => {
    expect(() => parseIssues(JSON.stringify([issue(1), issue(1)]))).toThrow('#1 twice')
  })
})

describe('ensureBuildHub', () => {
  it('is idempotent and makes the hub visible to the dev owner', async () => {
    await ensureBuildHub(db)
    const principals = await db
      .selectFrom('principal')
      .select(['id', 'kind', 'workspace_role', 'account_id'])
      .where('workspace_id', '=', WS)
      .orderBy('id')
      .execute()
    expect(principals).toEqual([
      { id: OWNER, kind: 'user', workspace_role: 'owner', account_id: OWNER },
      { id: IMPORT_ACTOR.id, kind: 'agent', workspace_role: 'member', account_id: null },
    ])
    // The owner signs in with the development password (#51).
    const account = await db
      .selectFrom('account')
      .select(['email', 'password_hash'])
      .where('id', '=', OWNER)
      .executeTakeFirstOrThrow()
    expect(account.email).toBe(DEV_OWNER.email)
    expect(await verifyPassword(DEV_PASSWORD, account.password_hash)).toBe(true)
    const attributes = await db
      .selectFrom('folder_attribute')
      .select(['attribute_id', 'position', 'required'])
      .where('workspace_id', '=', WS)
      .where('folder_id', '=', BUILD_HUB.id)
      .orderBy('position')
      .execute()
    expect(attributes.map((a) => a.attribute_id)).toEqual(Object.values(ATTR))
    // Owners see nothing inside a hub without a grant (D45), so the dev principal gets one,
    // logged once however often this runs.
    const grants = await db
      .selectFrom('hub_grant')
      .select(['hub_id', 'principal_id', 'hub_role'])
      .where('workspace_id', '=', WS)
      .execute()
    expect(grants).toEqual([{ hub_id: BUILD_HUB.id, principal_id: OWNER, hub_role: 'hub_admin' }])
    const log = await db
      .selectFrom('access_log')
      .select(['action', 'target'])
      .where('workspace_id', '=', WS)
      .execute()
    expect(log).toEqual([{ action: 'grant.set', target: OWNER }])
  })

  it('warns when the dev owner’s account ID is taken by another email', async () => {
    await db
      .updateTable('account')
      .set({ email: 'renamed@example.com' })
      .where('id', '=', OWNER)
      .execute()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await ensureBuildHub(db)
      expect(warn).toHaveBeenCalledWith(
        `seed: ${DEV_OWNER.email} not created, account ID ${OWNER} is taken; not linked`,
      )
    } finally {
      warn.mockRestore()
    }
    const emails = await db.selectFrom('account').select('email').execute()
    expect(emails).toEqual([{ email: 'renamed@example.com' }])
  })

  it('leaves an existing workspace and principal untouched', async () => {
    await db.updateTable('workspace').set({ name: 'Renamed' }).where('id', '=', WS).execute()
    await ensureBuildHub(db)
    const ws = await db.selectFrom('workspace').select('name').where('id', '=', WS).execute()
    expect(ws).toEqual([{ name: 'Renamed' }])
  })
})

describe('ensureBuildHub title (D50, #120)', () => {
  const hub = () =>
    db
      .selectFrom('folder')
      .select(['title_attribute_id', 'version'])
      .where('workspace_id', '=', WS)
      .where('id', '=', BUILD_HUB.id)
      .executeTakeFirstOrThrow()
  /** A hub admin's edit through `PATCH /hubs/build`, which bumps the version. */
  const editTitle = (titleAttributeId: string | null) =>
    withApi(async (call) => {
      const status = await call('PATCH', `/hubs/${BUILD_HUB.id}`, { version: 0, titleAttributeId })
      expect(status).toBe(200)
    })

  it('names Title as the hub’s title when it creates the hub, and keeps it on a re-run', async () => {
    expect(await hub()).toEqual({ title_attribute_id: ATTR.title, version: 0 })
    await ensureBuildHub(db)
    expect(await hub()).toEqual({ title_attribute_id: ATTR.title, version: 0 })
  })

  it('leaves a title a hub admin changed', async () => {
    await editTitle(ATTR.milestone)
    await ensureBuildHub(db)
    expect(await hub()).toEqual({ title_attribute_id: ATTR.milestone, version: 1 })
  })

  it('leaves a title a hub admin cleared', async () => {
    await editTitle(null)
    await ensureBuildHub(db)
    expect(await hub()).toEqual({ title_attribute_id: null, version: 1 })
  })

  it('names the title of a hub created before #120 and never edited, bumping its version', async () => {
    await db
      .updateTable('folder')
      .set({ title_attribute_id: null })
      .where('workspace_id', '=', WS)
      .where('id', '=', BUILD_HUB.id)
      .execute()
    await ensureBuildHub(db)
    expect(await hub()).toEqual({ title_attribute_id: ATTR.title, version: 1 })
    await ensureBuildHub(db)
    expect(await hub()).toEqual({ title_attribute_id: ATTR.title, version: 1 })
  })
})

describe('hubs and attributes deleted through the API (#143)', () => {
  const attributeIds = async () =>
    (
      await db
        .selectFrom('attribute')
        .select('id')
        .where('workspace_id', '=', WS)
        .orderBy('id')
        .execute()
    ).map((a) => a.id)
  const attached = async () =>
    (
      await db
        .selectFrom('folder_attribute')
        .select('attribute_id')
        .where('workspace_id', '=', WS)
        .orderBy('position')
        .execute()
    ).map((a) => a.attribute_id)

  it('does not bring back a deleted attribute, and imports without its values', async () => {
    await importIssues(db, [issue(1), issue(2)])
    await withApi(async (call) => {
      // Both items hold a stage, so the delete needs their number as confirm (D51).
      expect(await call('DELETE', `/attributes/${ATTR.stage}?version=0&confirm=2`)).toBe(204)
    })
    const expected = Object.values(ATTR).filter((id) => id !== ATTR.stage)

    expect(await ensureBuildHub(db)).toEqual({ hubDeleted: false })
    expect(await attributeIds()).toEqual([...expected].sort())
    expect(await attached()).toEqual(expected)

    // gh-1 is unchanged without its stage; gh-2 changed on GitHub; gh-3 is new.
    const result = await importIssues(db, [
      issue(1),
      issue(2, { labels: [{ name: 'stage:done' }, { name: 'role:qa' }] }),
      issue(3),
    ])
    expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, skipped: [], failed: [] })
    for (const id of ['gh-1', 'gh-2', 'gh-3']) {
      expect((await getItem(db, WS, id)).values).not.toHaveProperty(ATTR.stage)
    }
    expect((await getItem(db, WS, 'gh-2')).values[ATTR.role]).toBe('qa')
  })

  it('does not bring back a deleted title attribute, and leaves the title cleared', async () => {
    await withApi(async (call) => {
      expect(await call('DELETE', `/attributes/${ATTR.title}?version=0`)).toBe(204)
    })
    // The API cleared the title and bumped the hub's version.
    const hub = () =>
      db
        .selectFrom('folder')
        .select(['title_attribute_id', 'version'])
        .where('workspace_id', '=', WS)
        .where('id', '=', BUILD_HUB.id)
        .executeTakeFirstOrThrow()
    expect(await hub()).toEqual({ title_attribute_id: null, version: 1 })

    await ensureBuildHub(db)
    expect(await attributeIds()).not.toContain(ATTR.title)
    expect(await hub()).toEqual({ title_attribute_id: null, version: 1 })
    // Title was required; without it the issue still imports.
    expect((await importIssues(db, [issue(1)])).created).toBe(1)
    expect((await getItem(db, WS, 'gh-1')).values).not.toHaveProperty(ATTR.title)
  })

  it('does not bring back a deleted hub', async () => {
    await withApi(async (call) => {
      expect(await call('DELETE', `/hubs/${BUILD_HUB.id}?version=0`)).toBe(204)
    })
    const before = await workspaceSnapshot(db, WS)
    const log = await db
      .selectFrom('access_log')
      .selectAll()
      .where('workspace_id', '=', WS)
      .execute()

    expect(await ensureBuildHub(db)).toEqual({ hubDeleted: true })
    expect(
      await db.selectFrom('access_log').selectAll().where('workspace_id', '=', WS).execute(),
    ).toEqual(log)
    expect(await workspaceSnapshot(db, WS)).toEqual(before)
    expect(await attributeIds()).toEqual([])
    for (const table of ['folder', 'hub_grant'] as const) {
      const rows = await db.selectFrom(table).selectAll().where('workspace_id', '=', WS).execute()
      expect(rows, table).toEqual([])
    }
  })
})

describe('importIssues', () => {
  it('creates one item per issue with revisions and the hub count', async () => {
    const result = await importIssues(db, [issue(1), issue(2), issue(3, { state: 'CLOSED' })])
    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0, skipped: [], failed: [] })

    const item = await getItem(db, WS, 'gh-2')
    expect(item).toMatchObject({ hubId: BUILD_HUB.id, folderId: BUILD_HUB.id, version: 1 })
    expect(item.updatedBy).toBe(IMPORT_ACTOR.id)
    expect(item.values).toEqual({
      [ATTR.title]: 'Issue 2',
      [ATTR.issue]: 2,
      [ATTR.stage]: 'todo',
      [ATTR.role]: 'backend',
      [ATTR.milestone]: 'M0',
      [ATTR.url]: 'https://github.com/m3di/16bit/issues/2',
    })
    expect(await hubCount()).toBe(3)
    const log = await revisions()
    expect(log.map((r) => [r.item_id, r.version, r.actor])).toEqual([
      ['gh-1', 1, IMPORT_ACTOR.id],
      ['gh-2', 1, IMPORT_ACTOR.id],
      ['gh-3', 1, IMPORT_ACTOR.id],
    ])
    expect(log[0]?.patch).toMatchObject({ op: 'create', folderId: BUILD_HUB.id })
  })

  it('creates items oldest issue first', async () => {
    await importIssues(db, [issue(7), issue(2), issue(4)])
    const items = await db.selectFrom('item').select(['id', 'seq_id']).orderBy('seq_id').execute()
    expect(items.map((i) => i.id)).toEqual(['gh-2', 'gh-4', 'gh-7'])
  })

  it('writes nothing on a second run with the same issues', async () => {
    const issues = [issue(1), issue(2)]
    await importIssues(db, issues)
    const before = await revisions()

    expect(await importIssues(db, issues)).toEqual({
      created: 0,
      updated: 0,
      unchanged: 2,
      skipped: [],
      failed: [],
    })
    expect(await revisions()).toEqual(before)
    expect(await hubCount()).toBe(2)
    expect((await getItem(db, WS, 'gh-1')).version).toBe(1)
  })

  it('updates changed issues in place, patching only the changed values', async () => {
    await importIssues(db, [issue(1), issue(2)])
    const result = await importIssues(db, [
      issue(1, {
        title: 'Renamed',
        labels: [{ name: 'stage:done' }, { name: 'role:backend' }],
        milestone: null,
      }),
      issue(2),
      issue(5),
    ])
    expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, skipped: [], failed: [] })

    const item = await getItem(db, WS, 'gh-1')
    expect(item.version).toBe(2)
    expect(item.values[ATTR.title]).toBe('Renamed')
    expect(item.values[ATTR.stage]).toBe('done')
    expect(item.values).not.toHaveProperty(ATTR.milestone)
    expect(await hubCount()).toBe(3)

    const update = (await revisions()).find((r) => r.item_id === 'gh-1' && r.version === 2)
    expect(update?.patch).toEqual({
      op: 'update',
      values: { [ATTR.title]: 'Renamed', [ATTR.stage]: 'done', [ATTR.milestone]: null },
    })
  })

  it('overwrites a local edit of an imported value on the next run', async () => {
    await importIssues(db, [issue(1)])
    await patchItem(db, WS, OWNER, 'gh-1', { version: 1, values: { [ATTR.stage]: 'in-qa' } })

    expect((await importIssues(db, [issue(1)])).updated).toBe(1)
    const item = await getItem(db, WS, 'gh-1')
    expect(item.values[ATTR.stage]).toBe('todo')
    expect(item.version).toBe(3)
  })

  it('does not re-create an item deleted locally', async () => {
    await importIssues(db, [issue(1), issue(2)])
    await deleteItem(db, WS, OWNER, 'gh-1', 1)

    const result = await importIssues(db, [issue(1), issue(2)])
    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, skipped: [1], failed: [] })
    await expect(getItem(db, WS, 'gh-1')).rejects.toMatchObject({ code: 'not_found' })
    expect(await hubCount()).toBe(1)
  })

  it('reports an invalid value per issue and imports the rest', async () => {
    const tooLong = issue(9, { title: 'x'.repeat(10_001) })
    const result = await importIssues(db, [issue(1), tooLong, issue(12)])
    expect(result).toMatchObject({ created: 2, failed: [{ issue: 9, code: 'invalid_values' }] })
    expect(result.failed[0]?.message).toMatch(/^title: /)
    expect(await hubCount()).toBe(2)
    expect((await revisions()).map((r) => r.item_id)).toEqual(['gh-1', 'gh-12'])
    await expect(getItem(db, WS, 'gh-9')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports an invalid value on update and leaves the item as it was', async () => {
    await importIssues(db, [issue(1)])
    const result = await importIssues(db, [issue(1, { title: 'x'.repeat(10_001) }), issue(2)])
    expect(result).toMatchObject({ created: 1, failed: [{ issue: 1, code: 'invalid_values' }] })
    const item = await getItem(db, WS, 'gh-1')
    expect(item.version).toBe(1)
    expect(item.values[ATTR.title]).toBe('Issue 1')
  })

  it('reports a version conflict per issue and imports the rest', async () => {
    await importIssues(db, [issue(1)])

    // Another writer bumps gh-1 and holds its row lock. The importer reads version 1, then its
    // update waits on the lock; once the writer commits, the version check fails: a real 409.
    const other = new pg.Client({ connectionString: dbUrl })
    await other.connect()
    try {
      await other.query('BEGIN')
      await other.query(
        `UPDATE item SET version = version + 1 WHERE workspace_id = $1 AND id = 'gh-1'`,
        [WS],
      )
      const running = importIssues(db, [issue(1, { title: 'Renamed' }), issue(2)])
      await waitForLockWait()
      await other.query('COMMIT')

      const result = await running
      expect(result).toMatchObject({
        created: 1,
        updated: 0,
        failed: [{ issue: 1, code: 'conflict' }],
      })
    } finally {
      await other.end()
    }
    const item = await getItem(db, WS, 'gh-1')
    expect(item.version).toBe(2)
    expect(item.values[ATTR.title]).toBe('Issue 1')
    expect((await revisions()).map((r) => [r.item_id, r.version])).toEqual([
      ['gh-1', 1],
      ['gh-2', 1],
    ])
  })

  it('reports an item deleted between read and write per issue and imports the rest', async () => {
    await importIssues(db, [issue(1)])

    // Same lock trick as the conflict test, but the other writer deletes gh-1. Once it commits,
    // the importer's update matches no row and the item is gone: a 404 on the patch path.
    const other = new pg.Client({ connectionString: dbUrl })
    await other.connect()
    try {
      await other.query('BEGIN')
      await other.query(`DELETE FROM item WHERE workspace_id = $1 AND id = 'gh-1'`, [WS])
      const running = importIssues(db, [issue(1, { title: 'Renamed' }), issue(2)])
      await waitForLockWait()
      await other.query('COMMIT')

      const result = await running
      expect(result).toEqual({
        created: 1,
        updated: 0,
        unchanged: 0,
        skipped: [],
        failed: [{ issue: 1, code: 'not_found', message: 'Item not found' }],
      })
    } finally {
      await other.end()
    }
    await expect(getItem(db, WS, 'gh-1')).rejects.toMatchObject({ code: 'not_found' })
    expect(await getItem(db, WS, 'gh-2')).toMatchObject({ version: 1 })
    expect((await revisions()).map((r) => [r.item_id, r.version])).toEqual([
      ['gh-1', 1],
      ['gh-2', 1],
    ])

    // The next run sees the delete and skips the issue, as for any local delete.
    expect((await importIssues(db, [issue(1), issue(2)])).skipped).toEqual([1])
  })

  it('still stops the run on an error that is not about one issue', async () => {
    await db.deleteFrom('hub_grant').execute()
    await db.deleteFrom('folder_attribute').execute()
    await db.deleteFrom('attribute').execute()
    await db.deleteFrom('folder').execute()
    await expect(importIssues(db, [issue(1), issue(2)])).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('leaves an item with the same ID in another workspace unchanged', async () => {
    await db.insertInto('workspace').values({ id: 'other', name: 'Other' }).execute()
    await db
      .insertInto('principal')
      .values({
        workspace_id: 'other',
        id: 'them',
        kind: 'user',
        name: 'T',
        workspace_role: 'owner',
      })
      .execute()
    await db
      .insertInto('folder')
      .values({
        workspace_id: 'other',
        id: BUILD_HUB.id,
        hub_id: BUILD_HUB.id,
        parent_id: null,
        name: 'Theirs',
        color: 'blue',
        id_prefix: 'BLD',
        item_count: 1,
        next_seq: 2,
      })
      .execute()
    await db
      .insertInto('item')
      .values({
        workspace_id: 'other',
        id: 'gh-1',
        hub_id: BUILD_HUB.id,
        folder_id: BUILD_HUB.id,
        seq_id: 1,
        values: JSON.stringify({ [ATTR.title]: 'Theirs' }),
        updated_by: 'them',
      })
      .execute()
    const before = await workspaceSnapshot(db, 'other')

    // Create, then update, so both write paths run against the colliding ID.
    expect((await importIssues(db, [issue(1)])).created).toBe(1)
    expect((await importIssues(db, [issue(1, { title: 'Renamed' })])).updated).toBe(1)

    expect(await workspaceSnapshot(db, 'other')).toEqual(before)
    expect((await getItem(db, WS, 'gh-1')).values[ATTR.title]).toBe('Renamed')
  })
})

/** Resolves once a session in this test database is waiting on a lock. */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await sql<{ waiting: number }>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db)
    if ((rows[0]?.waiting ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The importer never waited on the row lock')
}

describe('seed:build-hub', () => {
  it('refuses to run with NODE_ENV=production unless --force is passed', async () => {
    const script = fileURLToPath(new URL('./seed-build-hub.ts', import.meta.url))
    // No MIGRATION_DATABASE_URL: the guard must fire before anything else, so nothing is written.
    const env = { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production' }
    const run = async (args: string[]): Promise<{ code: unknown; stderr: string }> => {
      try {
        await promisify(execFile)(process.execPath, [script, ...args], { env })
        return { code: 0, stderr: '' }
      } catch (error) {
        const { code, stderr } = error as { code: unknown; stderr: string }
        return { code, stderr }
      }
    }
    const refused = await run([])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('NODE_ENV=production')
    const forced = await run(['--force'])
    expect(forced.code).toBe(1)
    expect(forced.stderr).toContain('MIGRATION_DATABASE_URL is not set')
  }, 30_000)
})
