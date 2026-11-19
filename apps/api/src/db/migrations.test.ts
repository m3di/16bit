import { sql, type Kysely } from 'kysely'
import { Migrator, NO_MIGRATIONS } from 'kysely/migration'
import { attributeSchema, indexEntries, PALETTE_COLORS } from '@16bit/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { backfill } from './migrations/0002_item_index.ts'
import { migrations } from './migrations/index.ts'
import { createTestDatabase } from './test-database.ts'

const TABLES = [
  'access_log',
  'account',
  'agent_key',
  'attribute',
  'deleted_attribute',
  'deleted_hub',
  'folder',
  'folder_attribute',
  'hub_grant',
  'invite',
  'item',
  'item_index',
  'link',
  'principal',
  'revision',
  'session',
  'workspace',
]
// Installation-level tables sit outside workspace scope (D46).
const SCOPED_TABLES = TABLES.filter((t) => !['workspace', 'account', 'session'].includes(t))
// Lookups that run before a principal is known, through SECURITY DEFINER functions
// (docs/ARCHITECTURE.md, M1 auth). The only indexes allowed not to lead with workspace_id.
const UNSCOPED_LOOKUPS = [
  'agent_key_secret_hash_key',
  'invite_token_hash_key',
  'principal_account_idx',
]
// FKs from scoped tables to installation-level ones.
const UNSCOPED_FKS = ['principal_account_id_fkey']

let db: Kysely<Database>
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
})

afterEach(async () => {
  await db.destroy()
  await drop()
})

async function tables(): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%'
    ORDER BY table_name
  `.execute(db)
  return rows.map((r) => r.name)
}

async function seedHub(): Promise<void> {
  await db.insertInto('workspace').values({ id: 'w1', name: 'Workspace' }).execute()
  await db
    .insertInto('principal')
    .values({ workspace_id: 'w1', id: 'p1', kind: 'user', name: 'Owner', workspace_role: 'owner' })
    .execute()
  await db
    .insertInto('folder')
    .values([
      {
        workspace_id: 'w1',
        id: 'h1',
        hub_id: 'h1',
        parent_id: null,
        name: 'Build',
        color: 'blue',
        id_prefix: 'BLD',
      },
      {
        workspace_id: 'w1',
        id: 'h2',
        hub_id: 'h2',
        parent_id: null,
        name: 'Other',
        color: 'red',
        id_prefix: 'OTH',
      },
      {
        workspace_id: 'w1',
        id: 'f1',
        hub_id: 'h1',
        parent_id: 'h1',
        name: 'Issues',
        color: 'blue',
        id_prefix: 'ISS',
      },
    ])
    .execute()
}

describe('migrations', () => {
  it('applies to an empty database and creates every table', async () => {
    expect(await tables()).toEqual([])

    expect(await migrateToLatest(db)).toEqual([
      '0001_initial',
      '0002_item_index',
      '0003_auth_access',
      '0004_auth_functions',
      '0005_agent_key_lookup',
      '0006_link',
      '0007_principal_removed',
      '0008_row_level_security',
      '0009_schema_writes',
      '0010_invite_update_owner',
      '0011_deleted_attribute',
    ])
    expect(await tables()).toEqual(TABLES)
  })

  it('is a no-op when already up to date', async () => {
    await migrateToLatest(db)
    expect(await migrateToLatest(db)).toEqual([])
  })

  it('puts workspace_id first in every key, index, and foreign key', async () => {
    await migrateToLatest(db)

    const { rows: indexes } = await sql<{ table: string; index: string; first: string }>`
      SELECT t.relname AS table, i.relname AS index, a.attname AS first
      FROM pg_index x
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
      WHERE n.nspname = 'public' AND t.relname = ANY(${SCOPED_TABLES})
    `.execute(db)
    expect(indexes.length).toBeGreaterThan(SCOPED_TABLES.length)
    expect(
      indexes
        .filter((r) => r.first !== 'workspace_id')
        .map((r) => r.index)
        .sort(),
    ).toEqual(UNSCOPED_LOOKUPS)
    // Every scoped table has a primary key covered above.
    expect(new Set(indexes.map((r) => r.table))).toEqual(new Set(SCOPED_TABLES))

    const { rows: fks } = await sql<{ name: string; first: string }>`
      SELECT c.conname AS name, a.attname AS first
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(${SCOPED_TABLES})
    `.execute(db)
    expect(fks.filter((r) => r.first !== 'workspace_id').map((r) => r.name)).toEqual(UNSCOPED_FKS)
  })

  it('migrates down to an empty schema', async () => {
    await migrateToLatest(db)
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    })

    const { error } = await migrator.migrateTo(NO_MIGRATIONS)
    expect(error).toBeUndefined()
    expect(await tables()).toEqual([])
  })
})

describe('schema constraints', () => {
  beforeEach(async () => {
    await migrateToLatest(db)
    await seedHub()
  })

  it('accepts a valid item and revision', async () => {
    await db
      .insertInto('item')
      .values({
        workspace_id: 'w1',
        id: 'i1',
        hub_id: 'h1',
        folder_id: 'f1',
        seq_id: 1,
        values: JSON.stringify({ a1: 'hello' }),
        updated_by: 'p1',
      })
      .execute()
    await db
      .insertInto('revision')
      .values({
        workspace_id: 'w1',
        seq: 1,
        item_id: 'i1',
        hub_id: 'h1',
        version: 1,
        patch: JSON.stringify({ a1: 'hello' }),
        actor: 'p1',
        cause: 'm-1',
      })
      .execute()

    const item = await db.selectFrom('item').selectAll().executeTakeFirstOrThrow()
    expect(item).toMatchObject({ version: 1, seq_id: 1, values: { a1: 'hello' } })
    expect(typeof item.version).toBe('number')
  })

  it('rejects a hub whose hub_id is not its own id', async () => {
    await expect(
      db
        .insertInto('folder')
        .values({
          workspace_id: 'w1',
          id: 'h3',
          hub_id: 'h1',
          parent_id: null,
          name: 'X',
          color: 'teal',
          id_prefix: 'X',
        })
        .execute(),
    ).rejects.toThrow(/folder_check/)
  })

  it('rejects a folder whose parent is in another hub', async () => {
    await expect(
      db
        .insertInto('folder')
        .values({
          workspace_id: 'w1',
          id: 'f2',
          hub_id: 'h2',
          parent_id: 'f1',
          name: 'X',
          color: 'teal',
          id_prefix: 'X',
        })
        .execute(),
    ).rejects.toThrow(/foreign key/)
  })

  it('rejects an item whose hub_id does not match its folder', async () => {
    await expect(
      db
        .insertInto('item')
        .values({
          workspace_id: 'w1',
          id: 'i1',
          hub_id: 'h2',
          folder_id: 'f1',
          seq_id: 1,
          values: '{}',
          updated_by: 'p1',
        })
        .execute(),
    ).rejects.toThrow(/foreign key/)
  })

  it('rejects an item referencing a folder in another workspace', async () => {
    await db.insertInto('workspace').values({ id: 'w2', name: 'Other' }).execute()
    await db
      .insertInto('principal')
      .values({
        workspace_id: 'w2',
        id: 'p1',
        kind: 'user',
        name: 'Owner',
        workspace_role: 'owner',
      })
      .execute()

    await expect(
      db
        .insertInto('item')
        .values({
          workspace_id: 'w2',
          id: 'i1',
          hub_id: 'h1',
          folder_id: 'f1',
          seq_id: 1,
          values: '{}',
          updated_by: 'p1',
        })
        .execute(),
    ).rejects.toThrow(/foreign key/)
  })

  it('rejects a duplicate seq_id within a hub', async () => {
    const row = {
      workspace_id: 'w1',
      hub_id: 'h1',
      folder_id: 'f1',
      seq_id: 1,
      values: '{}',
      updated_by: 'p1',
    }
    await db
      .insertInto('item')
      .values({ ...row, id: 'i1' })
      .execute()
    await expect(
      db
        .insertInto('item')
        .values({ ...row, id: 'i2' })
        .execute(),
    ).rejects.toThrow(/unique/)
  })

  it('rejects item values that are not an object', async () => {
    await expect(
      db
        .insertInto('item')
        .values({
          workspace_id: 'w1',
          id: 'i1',
          hub_id: 'h1',
          folder_id: 'f1',
          seq_id: 1,
          values: '[]',
          updated_by: 'p1',
        })
        .execute(),
    ).rejects.toThrow(/item_values_check/)
  })

  it('rejects an unknown attribute type and principal kind', async () => {
    await expect(
      sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type) VALUES ('w1', 'a1', 'h1', 'A', 'email')`.execute(
        db,
      ),
    ).rejects.toThrow(/attribute_type_check/)
    await expect(
      sql`INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES ('w1', 'p2', 'bot', 'B', 'member')`.execute(
        db,
      ),
    ).rejects.toThrow(/principal_kind_check/)
  })

  it('accepts every M1 attribute type (0006)', async () => {
    for (const type of ['multi_select', 'url', 'actor', 'auto_id', 'rich_text', 'relation']) {
      await sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type) VALUES ('w1', ${type}, 'h1', 'A', ${type})`.execute(
        db,
      )
    }
  })

  it('rejects a duplicate revision seq in a workspace', async () => {
    const rev = { workspace_id: 'w1', seq: 1, hub_id: 'h1', patch: '{}', actor: 'p1', cause: null }
    await db
      .insertInto('revision')
      .values({ ...rev, item_id: 'i1', version: 1 })
      .execute()
    await expect(
      db
        .insertInto('revision')
        .values({ ...rev, item_id: 'i2', version: 1 })
        .execute(),
    ).rejects.toThrow(/revision_pkey/)
  })

  it('accepts every palette colour and rejects anything else', async () => {
    const folder = { workspace_id: 'w1', hub_id: 'h1', parent_id: 'h1', name: 'X', id_prefix: 'X' }
    await db
      .insertInto('folder')
      .values(PALETTE_COLORS.map((color) => ({ ...folder, id: `c-${color}`, color })))
      .execute()
    for (const color of ['#ff0000', 'purple', 'Blue']) {
      await expect(
        db
          .insertInto('folder')
          .values({ ...folder, id: 'bad', color })
          .execute(),
      ).rejects.toThrow(/folder_color_check/)
    }
  })

  it('rejects an attribute whose hub_id is not a hub', async () => {
    await expect(
      db
        .insertInto('attribute')
        .values({
          workspace_id: 'w1',
          id: 'a1',
          hub_id: 'f1',
          name: 'A',
          type: 'text',
          config: '{}',
        })
        .execute(),
    ).rejects.toThrow(/foreign key/)
  })

  describe('folder_attribute', () => {
    beforeEach(async () => {
      await db
        .insertInto('attribute')
        .values({
          workspace_id: 'w1',
          id: 'a1',
          hub_id: 'h1',
          name: 'A',
          type: 'text',
          config: '{}',
        })
        .execute()
    })

    const place = (row: { hub_id: string; folder_id: string }) =>
      db
        .insertInto('folder_attribute')
        .values({ workspace_id: 'w1', attribute_id: 'a1', position: 0, ...row })
        .execute()

    it('accepts an attribute on a folder in the same hub', async () => {
      await place({ hub_id: 'h1', folder_id: 'f1' })
      await place({ hub_id: 'h1', folder_id: 'h1' })
    })

    it('rejects a folder in h2 using an attribute from h1', async () => {
      // Labelled with the folder's hub: the attribute side fails.
      await expect(place({ hub_id: 'h2', folder_id: 'h2' })).rejects.toThrow(
        /folder_attribute_workspace_id_hub_id_attribute_id_fkey/,
      )
      // Labelled with the attribute's hub: the folder side fails.
      await expect(place({ hub_id: 'h1', folder_id: 'h2' })).rejects.toThrow(
        /folder_attribute_workspace_id_hub_id_folder_id_fkey/,
      )
    })
  })

  it('starts the item and revision counters at 1', async () => {
    const hub = await db
      .selectFrom('folder')
      .select(['next_seq', 'version'])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'h1')
      .executeTakeFirstOrThrow()
    expect(hub).toEqual({ next_seq: 1, version: 0 })
    const ws = await db
      .selectFrom('workspace')
      .select('next_revision_seq')
      .where('id', '=', 'w1')
      .executeTakeFirstOrThrow()
    expect(ws.next_revision_seq).toBe(1)
  })
})

describe('0002_item_index', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

  // One indexed attribute per M0 type, two date configs, and one unindexed attribute.
  const attributes = [
    { id: 'title', type: 'text', config: {}, indexed: true },
    { id: 'points', type: 'number', config: {}, indexed: true },
    { id: 'done', type: 'boolean', config: {}, indexed: true },
    { id: 'due', type: 'date', config: {}, indexed: true },
    { id: 'at', type: 'date', config: { includeTime: true }, indexed: true },
    {
      id: 'stage',
      type: 'select',
      config: { options: [{ id: 'todo', label: 'To do' }] },
      indexed: true,
    },
    { id: 'notes', type: 'text', config: {}, indexed: false },
  ] as const
  // Indexed, but not shown on f1: the write path does not index it, so neither does the backfill.
  const offFolder = { id: 'off', type: 'number', config: {}, indexed: true } as const
  const items: Record<string, Record<string, unknown>> = {
    i1: {
      title: 'Hello',
      points: 2.5,
      done: false,
      due: '2026-11-16',
      at: '2026-11-16T10:00:00+03:30',
      stage: 'todo',
      notes: 'not indexed',
      off: 1,
    },
    i2: { title: 'Other', points: -3, done: true },
    // Wrong JSON types are skipped instead of failing the migration.
    i3: { title: 7, points: 'x', done: 'yes' },
  }

  async function seedItems(): Promise<void> {
    await seedHub()
    await db
      .insertInto('attribute')
      .values(
        [...attributes, offFolder].map((a) => ({
          workspace_id: 'w1',
          hub_id: 'h1',
          name: a.id,
          id: a.id,
          type: a.type,
          config: JSON.stringify(a.config),
          indexed: a.indexed,
        })),
      )
      .execute()
    await db
      .insertInto('folder_attribute')
      .values(
        attributes.map((a, position) => ({
          workspace_id: 'w1',
          hub_id: 'h1',
          folder_id: 'f1',
          attribute_id: a.id,
          position,
        })),
      )
      .execute()
    await db
      .insertInto('item')
      .values(
        Object.entries(items).map(([id, values], n) => ({
          workspace_id: 'w1',
          id,
          hub_id: 'h1',
          folder_id: 'f1',
          seq_id: n + 1,
          values: JSON.stringify(values),
          updated_by: 'p1',
        })),
      )
      .execute()
  }

  /** What the write path writes, from the core projection. */
  function expected() {
    const rows: { attribute_id: string; item_id: string; ord: number; value: string }[] = []
    for (const [itemId, values] of Object.entries(items)) {
      if (itemId === 'i3') continue
      for (const a of attributes) {
        const value = values[a.id]
        if (value === undefined) continue
        const attribute = attributeSchema.parse({
          ...a,
          workspaceId: 'w1',
          hubId: 'h1',
          version: 0,
          name: a.id,
        })
        for (const e of indexEntries(attribute, value as string | number | boolean)) {
          rows.push({ attribute_id: a.id, item_id: itemId, ord: e.ord, value: String(e.value) })
        }
      }
    }
    return rows.sort((x, y) =>
      `${x.item_id}${x.attribute_id}`.localeCompare(`${y.item_id}${y.attribute_id}`),
    )
  }

  async function actual() {
    const { rows } = await sql<{
      attribute_id: string
      item_id: string
      ord: number
      value: string
    }>`
      SELECT attribute_id, item_id, ord,
        coalesce(num::text, txt,
          to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS value
      FROM item_index WHERE workspace_id = 'w1'
    `.execute(db)
    return rows.sort((x, y) =>
      `${x.item_id}${x.attribute_id}`.localeCompare(`${y.item_id}${y.attribute_id}`),
    )
  }

  it('backfills existing items exactly as the write path projects them', async () => {
    expect((await migrator().migrateTo('0001_initial')).error).toBeUndefined()
    await seedItems()
    await migrateToLatest(db)
    expect(await actual()).toEqual(expected())
  })

  it('backfills a calendar date as UTC midnight in any session time zone', async () => {
    await migrateToLatest(db)
    await seedItems()
    await db.connection().execute(async (conn) => {
      await sql`SET TIME ZONE 'Pacific/Kiritimati'`.execute(conn)
      await backfill(conn as unknown as Kysely<unknown>)
    })
    expect(await actual()).toEqual(expected())
  })

  it('removes an item’s index rows with the item, and keeps one typed column per row', async () => {
    await migrateToLatest(db)
    await seedItems()
    await backfill(db as unknown as Kysely<unknown>)
    await db.deleteFrom('item').where('id', '=', 'i1').execute()
    expect((await actual()).filter((r) => r.item_id === 'i1')).toEqual([])
    await expect(
      sql`INSERT INTO item_index (workspace_id, attribute_id, item_id, num, txt) VALUES ('w1', 'title', 'i2', 1, 'x')`.execute(
        db,
      ),
    ).rejects.toThrow(/item_index_check/)
  })

  it('allows several rows per item and attribute, numbered by ord', async () => {
    await migrateToLatest(db)
    await seedItems()
    await sql`INSERT INTO item_index (workspace_id, attribute_id, item_id, ord, txt) VALUES ('w1', 'stage', 'i2', 0, 'a'), ('w1', 'stage', 'i2', 1, 'b')`.execute(
      db,
    )
    await expect(
      sql`INSERT INTO item_index (workspace_id, attribute_id, item_id, ord, txt) VALUES ('w1', 'stage', 'i2', 1, 'c')`.execute(
        db,
      ),
    ).rejects.toThrow(/item_index_pkey/)
  })
})

describe('0006_link', () => {
  beforeEach(async () => {
    await migrateToLatest(db)
    await seedHub()
    await sql`
      INSERT INTO attribute (workspace_id, id, hub_id, name, type, config)
        VALUES ('w1', 'rel', 'h1', 'Rel', 'relation', '{"targetHubId":"h1"}');
      INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, updated_by) VALUES
        ('w1', 'a', 'h1', 'f1', 1, 'p1'), ('w1', 'b', 'h1', 'f1', 2, 'p1'),
        ('w1', 'c', 'h1', 'f1', 3, 'p1');
      INSERT INTO link (workspace_id, from_item, attribute_id, to_item) VALUES
        ('w1', 'a', 'rel', 'b'), ('w1', 'b', 'rel', 'c'), ('w1', 'c', 'rel', 'a');
    `.execute(db)
  })

  const links = async () =>
    (
      await db.selectFrom('link').select(['from_item', 'to_item']).orderBy('from_item').execute()
    ).map((r) => `${r.from_item}>${r.to_item}`)

  it('removes links from and to an item when it is deleted', async () => {
    await sql`DELETE FROM item WHERE id = 'b'`.execute(db)
    expect(await links()).toEqual(['c>a'])
  })

  it('removes links with their attribute', async () => {
    await sql`DELETE FROM attribute WHERE id = 'rel'`.execute(db)
    expect(await links()).toEqual([])
  })

  it('rejects a link to an item that does not exist or is in another workspace', async () => {
    await db.insertInto('workspace').values({ id: 'w2', name: 'Two' }).execute()
    await expect(
      sql`INSERT INTO link (workspace_id, from_item, attribute_id, to_item) VALUES ('w1', 'a', 'rel', 'zz')`.execute(
        db,
      ),
    ).rejects.toThrow(/link_workspace_id_to_item_fkey/)
    await expect(
      sql`INSERT INTO link (workspace_id, from_item, attribute_id, to_item) VALUES ('w2', 'a', 'rel', 'b')`.execute(
        db,
      ),
    ).rejects.toThrow(/link_workspace_id_from_item_fkey/)
  })

  it('rejects the same link twice', async () => {
    await expect(
      sql`INSERT INTO link (workspace_id, from_item, attribute_id, to_item) VALUES ('w1', 'a', 'rel', 'b')`.execute(
        db,
      ),
    ).rejects.toThrow(/link_pkey/)
  })

  it('migrates down only once no attribute uses an M1 type', async () => {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    })
    const blocked = await migrator.migrateTo('0005_agent_key_lookup')
    expect(blocked.error).toBeDefined()
    expect(await tables()).toContain('link')

    await sql`DELETE FROM attribute WHERE id = 'rel'`.execute(db)
    // The tombstone (#133) would hold 0011 back; that is tested under 0011.
    await sql`DELETE FROM deleted_attribute`.execute(db)
    const { error } = await migrator.migrateTo('0005_agent_key_lookup')
    expect(error).toBeUndefined()
    expect(await tables()).not.toContain('link')
  })
})

describe('0007_principal_removed', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

  beforeEach(async () => {
    await migrateToLatest(db)
    await db.insertInto('workspace').values({ id: 'w1', name: 'W' }).execute()
    await db
      .insertInto('account')
      .values({ id: 'a1', email: 'a@example.com', password_hash: '$argon2id$x', name: 'A' })
      .execute()
    await db
      .insertInto('principal')
      .values([
        { workspace_id: 'w1', id: 'p1', kind: 'user', name: 'P', workspace_role: 'member' },
        {
          workspace_id: 'w1',
          id: 'p2',
          kind: 'user',
          name: 'Q',
          workspace_role: 'member',
          account_id: 'a1',
        },
        { workspace_id: 'w1', id: 'bot', kind: 'agent', name: 'B', workspace_role: 'member' },
      ])
      .execute()
  })

  const remove = (id: string) =>
    db
      .updateTable('principal')
      .set({ removed_at: sql`now()` })
      .where('id', '=', id)
      .execute()

  it('only removes people whose account is unlinked', async () => {
    await remove('p1')
    await expect(remove('p2')).rejects.toThrow(/principal_removed_check/)
    await expect(remove('bot')).rejects.toThrow(/principal_removed_check/)
  })

  it('migrates down only while nobody is removed', async () => {
    await remove('p1')
    const { error } = await migrator().migrateTo('0006_link')
    expect(String(error)).toMatch(/removed members/)
    await db.updateTable('principal').set({ removed_at: null }).where('id', '=', 'p1').execute()
    expect((await migrator().migrateTo('0006_link')).error).toBeUndefined()
  })
})

describe('0008_row_level_security', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

  it('gives every existing revision its hub, a deleted item’s from its create revision', async () => {
    expect((await migrator().migrateTo('0007_principal_removed')).error).toBeUndefined()
    await seedHub()
    await sql`
      INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, updated_by)
        VALUES ('w1', 'live', 'h1', 'f1', 1, 'p1');
      INSERT INTO revision (workspace_id, seq, item_id, version, patch, actor) VALUES
        ('w1', 1, 'live', 1, '{"op":"create","folderId":"f1","values":{}}', 'p1'),
        ('w1', 2, 'gone', 1, '{"op":"create","folderId":"h2","values":{}}', 'p1'),
        ('w1', 3, 'gone', 2, '{"op":"delete"}', 'p1');
    `.execute(db)

    expect((await migrator().migrateTo('0008_row_level_security')).error).toBeUndefined()
    const rows = await db.selectFrom('revision').select(['seq', 'hub_id']).orderBy('seq').execute()
    expect(rows).toEqual([
      { seq: 1, hub_id: 'h1' },
      { seq: 2, hub_id: 'h2' },
      { seq: 3, hub_id: 'h2' },
    ])

    expect((await migrator().migrateTo('0007_principal_removed')).error).toBeUndefined()
    const { rows: rls } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relrowsecurity
    `.execute(db)
    expect(rls[0]?.n).toBe(0)
  })
})

describe('0009_schema_writes', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

  it('applies to a database migrated to 0008 with data, and migrates back down', async () => {
    expect((await migrator().migrateTo('0008_row_level_security')).error).toBeUndefined()
    await seedHub()
    await sql`
      INSERT INTO attribute (workspace_id, id, hub_id, name, type) VALUES ('w1', 't', 'h1', 'T', 'text');
      INSERT INTO folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position)
        VALUES ('w1', 'h1', 'f1', 't', 0);
      INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor)
        VALUES ('w1', 1, 'i1', 'h1', 1, '{"op":"create","folderId":"f1","values":{}}', 'p1');
    `.execute(db)

    expect(await migrateToLatest(db)).toEqual([
      '0009_schema_writes',
      '0010_invite_update_owner',
      '0011_deleted_attribute',
    ])
    expect(await db.selectFrom('attribute').select(['id', 'version']).execute()).toEqual([
      { id: 't', version: 0 },
    ])
    const hubs = await db
      .selectFrom('folder')
      .select(['id', 'title_attribute_id'])
      .orderBy('id')
      .execute()
    expect(hubs.every((h) => h.title_attribute_id === null)).toBe(true)
    await db.updateTable('folder').set({ title_attribute_id: 't' }).where('id', '=', 'h1').execute()

    expect((await migrator().migrateTo('0008_row_level_security')).error).toBeUndefined()
    expect(await tables()).not.toContain('deleted_hub')
    // The revision foreign key is back.
    await expect(
      sql`INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor)
          VALUES ('w1', 2, 'i2', 'nope', 1, '{"op":"create"}', 'p1')`.execute(db),
    ).rejects.toThrow(/revision_hub_fkey/)
  })

  it('migrates down only while no hub has been deleted', async () => {
    await migrateToLatest(db)
    await seedHub()
    await db
      .insertInto('deleted_hub')
      .values({ workspace_id: 'w1', id: 'gone', deleted_by: 'p1' })
      .execute()
    const { error } = await migrator().migrateTo('0008_row_level_security')
    expect(String(error)).toMatch(/hubs have been deleted/)
  })
})

describe('0010_invite_update_owner', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })
  const policy = async () => {
    const { rows } = await sql<{ check: string }>`
      SELECT with_check AS check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'invite' AND policyname = 'invite_update'
    `.execute(db)
    return rows[0]?.check ?? null
  }

  it('applies after 0009 and migrates back down to the 0008 policy', async () => {
    expect((await migrator().migrateTo('0009_schema_writes')).error).toBeUndefined()
    const before = await policy()
    expect(await migrateToLatest(db)).toEqual([
      '0010_invite_update_owner',
      '0011_deleted_attribute',
    ])
    expect(await policy()).toMatch(/owner/)
    expect((await migrator().migrateTo('0009_schema_writes')).error).toBeUndefined()
    expect(await policy()).toBe(before)
  })
})

describe('0011_deleted_attribute', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

  it('backfills the attributes revisions name that no longer exist, and migrates back down', async () => {
    expect((await migrator().migrateTo('0010_invite_update_owner')).error).toBeUndefined()
    await seedHub()
    // `live` still exists; `gone` (in two revisions) and `old` were deleted before 0011. The
    // delete revision and a patch without values name no attribute.
    await sql`
      INSERT INTO attribute (workspace_id, id, hub_id, name, type)
        VALUES ('w1', 'live', 'h1', 'Live', 'text'), ('w1', 'gone', 'h1', 'Gone', 'text'),
               ('w1', 'old', 'h2', 'Old', 'number');
      INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor) VALUES
        ('w1', 1, 'i1', 'h1', 1, '{"op":"create","folderId":"f1","values":{"live":"a","gone":"b"}}', 'p1'),
        ('w1', 2, 'i1', 'h1', 2, '{"op":"update","values":{"gone":null}}', 'p1'),
        ('w1', 3, 'i2', 'h2', 1, '{"op":"create","folderId":"h2","values":{"old":1}}', 'p1'),
        ('w1', 4, 'i2', 'h2', 2, '{"op":"delete"}', 'p1');
      DELETE FROM attribute WHERE id IN ('gone', 'old');
    `.execute(db)

    expect(await migrateToLatest(db)).toEqual(['0011_deleted_attribute'])
    const backfilled = await db
      .selectFrom('deleted_attribute')
      .select(['workspace_id', 'id', 'hub_id', 'deleted_by'])
      .orderBy('id')
      .execute()
    expect(backfilled).toEqual([
      { workspace_id: 'w1', id: 'gone', hub_id: 'h1', deleted_by: null },
      { workspace_id: 'w1', id: 'old', hub_id: 'h2', deleted_by: null },
    ])
    await expect(
      sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type)
          VALUES ('w1', 'old', 'h1', 'Again', 'text')`.execute(db),
    ).rejects.toMatchObject({ code: '23505' })

    // Down refuses while a tombstone exists.
    const blocked = await migrator().migrateTo('0010_invite_update_owner')
    expect(String(blocked.error)).toMatch(/attributes have been deleted/)
    expect(await tables()).toContain('deleted_attribute')

    await sql`DELETE FROM deleted_attribute`.execute(db)
    expect((await migrator().migrateTo('0010_invite_update_owner')).error).toBeUndefined()
    expect(await tables()).not.toContain('deleted_attribute')
    // The triggers are gone with it: an attribute deletes and its ID comes back.
    await sql`DELETE FROM attribute WHERE id = 'live'`.execute(db)
    await sql`INSERT INTO attribute (workspace_id, id, hub_id, name, type)
              VALUES ('w1', 'live', 'h1', 'Live', 'number')`.execute(db)
  })
})
