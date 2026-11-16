import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTR,
  BUILD_HUB,
  BUILD_WORKSPACE,
  ensureBuildHub,
  ghIssueSchema,
  importIssues,
  IMPORT_ACTOR,
  toValues,
  type GhIssue,
} from './build-hub.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { deleteItem, getItem, patchItem } from './items.ts'

// Integration tests against a fresh, migrated Postgres per test. `gh` is not called:
// the importer takes parsed issues, so fixtures stand in for its output.

const OWNER = 'dev-owner'
const WS = BUILD_WORKSPACE.id

let db: Kysely<Database>
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
  await ensureBuildHub(db, OWNER)
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

describe('ensureBuildHub', () => {
  it('is idempotent and makes the hub visible to the dev principal', async () => {
    await ensureBuildHub(db, OWNER)
    const principals = await db
      .selectFrom('principal')
      .select(['id', 'kind', 'workspace_role'])
      .where('workspace_id', '=', WS)
      .orderBy('id')
      .execute()
    expect(principals).toEqual([
      { id: OWNER, kind: 'user', workspace_role: 'owner' },
      { id: IMPORT_ACTOR.id, kind: 'agent', workspace_role: 'member' },
    ])
    const attributes = await db
      .selectFrom('folder_attribute')
      .select(['attribute_id', 'position', 'required'])
      .where('workspace_id', '=', WS)
      .where('folder_id', '=', BUILD_HUB.id)
      .orderBy('position')
      .execute()
    expect(attributes.map((a) => a.attribute_id)).toEqual(Object.values(ATTR))
  })

  it('leaves an existing workspace and principal untouched', async () => {
    await db.updateTable('workspace').set({ name: 'Renamed' }).where('id', '=', WS).execute()
    await ensureBuildHub(db, OWNER)
    const ws = await db.selectFrom('workspace').select('name').where('id', '=', WS).execute()
    expect(ws).toEqual([{ name: 'Renamed' }])
  })
})

describe('importIssues', () => {
  it('creates one item per issue with revisions and the hub count', async () => {
    const result = await importIssues(db, [issue(1), issue(2), issue(3, { state: 'CLOSED' })])
    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0, skipped: [] })

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
    expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, skipped: [] })

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
    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, skipped: [1] })
    await expect(getItem(db, WS, 'gh-1')).rejects.toMatchObject({ code: 'not_found' })
    expect(await hubCount()).toBe(1)
  })

  it('fails on a value the hub rejects and writes nothing for it', async () => {
    const tooLong = issue(9, { title: 'x'.repeat(10_001) })
    await expect(importIssues(db, [tooLong])).rejects.toMatchObject({ code: 'invalid_values' })
    expect(await hubCount()).toBe(0)
    expect(await revisions()).toEqual([])
  })

  it('stays inside the team workspace', async () => {
    await db.insertInto('workspace').values({ id: 'other', name: 'Other' }).execute()
    await importIssues(db, [issue(1)])
    const elsewhere = await db
      .selectFrom('item')
      .select('id')
      .where('workspace_id', '!=', WS)
      .execute()
    expect(elsewhere).toEqual([])
  })
})
