import { sql, type Kysely } from 'kysely'
import { Migrator, NO_MIGRATIONS } from 'kysely/migration'
import { attributeSchema, externalKeySchema, indexEntries, PALETTE_COLORS } from '@16bit/core'
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
      '0012_mutation_ids',
      '0013_hub_prefix_unique',
      '0014_revision_cause',
      '0015_item_external_key',
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
        cause: JSON.stringify({ note: 'm-1' }),
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
      '0012_mutation_ids',
      '0013_hub_prefix_unique',
      '0014_revision_cause',
      '0015_item_external_key',
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
      '0012_mutation_ids',
      '0013_hub_prefix_unique',
      '0014_revision_cause',
      '0015_item_external_key',
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

    expect(await migrateToLatest(db)).toEqual([
      '0011_deleted_attribute',
      '0012_mutation_ids',
      '0013_hub_prefix_unique',
      '0014_revision_cause',
      '0015_item_external_key',
    ])
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

describe('0012_mutation_ids', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })
  const M1 = '7f0c2a1e-3b4d-4c5e-8f60-718293a4b5c6'
  const M2 = '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3'
  const revision = (seq: number, version: number, actor: string, id: string | null) =>
    sql`INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor,
                              client_mutation_id)
        VALUES ('w1', ${seq}, 'i1', 'h1', ${version}, '{"op":"update","values":{}}', ${actor},
                ${id})`.execute(db)
  const indexDef = async (name: string) => {
    const { rows } = await sql<{ def: string }>`
      SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
    `.execute(db)
    return rows[0]?.def ?? null
  }

  it('applies to a database migrated to 0011 with data, and migrates back down', async () => {
    expect((await migrator().migrateTo('0011_deleted_attribute')).error).toBeUndefined()
    await seedHub()
    await sql`
      INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
        VALUES ('w1', 'i1', 'h1', 'f1', 1, '{}', 'p1');
      INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor)
        VALUES ('w1', 1, 'i1', 'h1', 1, '{"op":"create","folderId":"f1","values":{}}', 'p1');
    `.execute(db)

    expect(await migrateToLatest(db)).toEqual([
      '0012_mutation_ids',
      '0013_hub_prefix_unique',
      '0014_revision_cause',
      '0015_item_external_key',
    ])
    // Existing revisions carry no ID.
    expect(await db.selectFrom('revision').select(['seq', 'client_mutation_id']).execute()).toEqual(
      [{ seq: 1, client_mutation_id: null }],
    )
    expect(await indexDef('revision_client_mutation_key')).toMatch(
      /UNIQUE INDEX .* \(workspace_id, actor, client_mutation_id\) WHERE \(client_mutation_id IS NOT NULL\)/,
    )
    expect(await indexDef('item_folder_number_idx')).toMatch(
      /\(workspace_id, folder_id, seq_id DESC\)/,
    )

    expect((await migrator().migrateTo('0011_deleted_attribute')).error).toBeUndefined()
    expect(await indexDef('revision_client_mutation_key')).toBeNull()
    expect(await indexDef('item_folder_number_idx')).toBeNull()
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'revision' AND column_name = 'client_mutation_id'
    `.execute(db)
    expect(rows[0]?.n).toBe(0)
  })

  describe('on the latest schema', () => {
    beforeEach(async () => {
      await migrateToLatest(db)
      await seedHub()
      await sql`
        INSERT INTO principal (workspace_id, id, kind, name, workspace_role)
          VALUES ('w1', 'p2', 'user', 'Second', 'member');
        INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
          VALUES ('w1', 'i1', 'h1', 'f1', 1, '{}', 'p1');
      `.execute(db)
    })

    it('refuses an ID twice for one actor in a workspace, and allows it for another actor', async () => {
      await revision(1, 1, 'p1', M1)
      await expect(revision(2, 2, 'p1', M1)).rejects.toMatchObject({
        code: '23505',
        constraint: 'revision_client_mutation_key',
      })
      await revision(2, 2, 'p2', M1)
      await revision(3, 3, 'p1', M2)
    })

    it('never compares writes without an ID', async () => {
      await revision(1, 1, 'p1', null)
      await revision(2, 2, 'p1', null)
      expect(await db.selectFrom('revision').select('seq').execute()).toHaveLength(2)
    })

    it('refuses an ID that is not a UUID', async () => {
      await expect(revision(1, 1, 'p1', 'not-a-uuid')).rejects.toMatchObject({ code: '22P02' })
    })

    it('reads a folder by item number from item_folder_number_idx without a sort', async () => {
      const plan = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL enable_sort = off`.execute(trx)
        await sql`SET LOCAL enable_seqscan = off`.execute(trx)
        const { rows } = await sql<{ 'QUERY PLAN': string }>`
          EXPLAIN SELECT id FROM item WHERE workspace_id = 'w1' AND folder_id = 'f1'
          ORDER BY seq_id DESC LIMIT 200 OFFSET 400
        `.execute(trx)
        return rows.map((r) => r['QUERY PLAN']).join('\n')
      })
      expect(plan).toContain('item_folder_number_idx')
      expect(plan).not.toMatch(/Sort/)
    })
  })
})

describe('0013_hub_prefix_unique', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })
  const hub = (workspace: string, id: string, prefix: string) =>
    sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
        VALUES (${workspace}, ${id}, ${id}, NULL, ${id}, 'blue', ${prefix})`.execute(db)

  it('stops with a message naming hubs that share a prefix, then applies once they are fixed', async () => {
    expect((await migrator().migrateTo('0012_mutation_ids')).error).toBeUndefined()
    await seedHub()
    await sql`INSERT INTO workspace (id, name) VALUES ('w2', 'Second')`.execute(db)
    await hub('w1', 'h3', 'BLD')
    await hub('w1', 'h4', 'OTH')
    await hub('w1', 'h5', 'OTH')
    // Another workspace may use the same prefix.
    await hub('w2', 'h1', 'BLD')

    const { error } = await migrator().migrateToLatest()
    expect((error as Error).message).toBe(
      'hub ID prefixes must be unique in a workspace (D56); 2 shared: ' +
        'workspace w1, prefix BLD: hubs h1, h3; workspace w1, prefix OTH: hubs h2, h4, h5',
    )
    expect((error as { hint?: string }).hint).toMatch(/new prefix/)

    await sql`UPDATE folder SET id_prefix = 'NEW' WHERE workspace_id = 'w1' AND hub_id = 'h3';
              DELETE FROM folder WHERE workspace_id = 'w1' AND id IN ('h4', 'h5')`.execute(db)
    expect(await migrateToLatest(db)).toEqual([
      '0013_hub_prefix_unique',
      '0014_revision_cause',
      '0015_item_external_key',
    ])

    expect((await migrator().migrateTo('0012_mutation_ids')).error).toBeUndefined()
    await hub('w1', 'h6', 'BLD')
  })

  it('names at most 20 prefixes and counts the rest', async () => {
    expect((await migrator().migrateTo('0012_mutation_ids')).error).toBeUndefined()
    await sql`INSERT INTO workspace (id, name) VALUES ('w1', 'Workspace')`.execute(db)
    for (let n = 0; n < 22; n++) {
      const prefix = `P${String(n).padStart(2, '0')}`
      await hub('w1', `a${String(n)}`, prefix)
      await hub('w1', `b${String(n)}`, prefix)
    }
    const { error } = await migrator().migrateToLatest()
    const message = (error as Error).message
    expect(message).toMatch(/^hub ID prefixes must be unique in a workspace \(D56\); 22 shared: /)
    expect(message).toContain('prefix P19: hubs a19, b19; and 2 more')
    expect(message).not.toContain('P20')
  })

  describe('on the latest schema', () => {
    beforeEach(async () => {
      await migrateToLatest(db)
      await seedHub()
    })

    it('refuses a second hub with a prefix in its workspace', async () => {
      await expect(hub('w1', 'h3', 'BLD')).rejects.toMatchObject({
        code: '23505',
        constraint: 'folder_hub_prefix_key',
      })
    })

    it('allows the prefix in another workspace, on subfolders, and once its hub is gone', async () => {
      await sql`INSERT INTO workspace (id, name) VALUES ('w2', 'Second')`.execute(db)
      await hub('w2', 'h1', 'BLD')
      // Subfolders carry their hub's prefix.
      await sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
                VALUES ('w1', 'f2', 'h1', 'h1', 'More', 'blue', 'BLD'),
                       ('w1', 'f3', 'h2', 'h2', 'Also', 'red', 'BLD')`.execute(db)
      await sql`DELETE FROM folder WHERE workspace_id = 'w1' AND id IN ('f3', 'h2')`.execute(db)
      await hub('w1', 'h3', 'OTH')
    })
  })
})

describe('0014_revision_cause', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })
  const revision = (seq: number, cause: string | null) =>
    sql`INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor, cause)
        VALUES ('w1', ${seq}, 'i1', 'h1', ${seq}, '{"op":"update","values":{}}', 'p1',
                ${cause})`.execute(db)
  const causes = async () => {
    const { rows } = await sql<{ seq: number; cause: unknown }>`
      SELECT seq, cause FROM revision ORDER BY seq
    `.execute(db)
    return rows.map((r) => [r.seq, r.cause])
  }
  const withItem = () =>
    sql`
    INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
      VALUES ('w1', 'i1', 'h1', 'f1', 1, '{}', 'p1')
  `.execute(db)

  it('applies to a database migrated to 0013 with data, keeps text as a trimmed note, and migrates down and up again', async () => {
    const long = 'n'.repeat(500)
    expect((await migrator().migrateTo('0013_hub_prefix_unique')).error).toBeUndefined()
    await seedHub()
    await withItem()
    await revision(1, 'from the old column')
    await revision(2, '')
    await revision(3, null)
    await revision(4, long)
    await revision(5, ' \n\t ')
    await revision(6, `  ${long}\n`)
    await revision(7, '\u00a0 padded\t')

    expect(await migrateToLatest(db)).toEqual(['0014_revision_cause', '0015_item_external_key'])
    const migrated = [
      [1, { note: 'from the old column' }],
      [2, null],
      [3, null],
      [4, { note: long }],
      // Trimmed as core trims a note; blank is none.
      [5, null],
      [6, { note: long }],
      [7, { note: 'padded' }],
    ]
    expect(await causes()).toEqual(migrated)
    const { rows } = await sql<{ type: string }>`
      SELECT data_type AS type FROM information_schema.columns
      WHERE table_name = 'revision' AND column_name = 'cause'
    `.execute(db)
    expect(rows[0]?.type).toBe('jsonb')

    // Down: a note-only cause goes back to its text; any other to its JSON text.
    expect((await migrator().migrateTo('0013_hub_prefix_unique')).error).toBeUndefined()
    expect(await causes()).toEqual([
      [1, 'from the old column'],
      [2, null],
      [3, null],
      [4, long],
      [5, null],
      [6, long],
      [7, 'padded'],
    ])
    const { rows: functions } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'revision_cause_%'
    `.execute(db)
    expect(functions[0]?.n).toBe(0)

    // Up again gives the same causes.
    expect(await migrateToLatest(db)).toEqual(['0014_revision_cause', '0015_item_external_key'])
    expect(await causes()).toEqual(migrated)

    // A structured cause survives down as JSON text, which up then reads as a note.
    await sql`UPDATE revision SET cause = '{"evidence":["https://e.example/1"],"causedBy":1}'
              WHERE seq = 3`.execute(db)
    expect((await migrator().migrateTo('0013_hub_prefix_unique')).error).toBeUndefined()
    const json = '{"causedBy": 1, "evidence": ["https://e.example/1"]}'
    expect((await causes())[2]).toEqual([3, json])
    expect(await migrateToLatest(db)).toEqual(['0014_revision_cause', '0015_item_external_key'])
    expect((await causes())[2]).toEqual([3, { note: json }])
  })

  it('stops on a text cause longer than a note, and applies once it is shortened', async () => {
    expect((await migrator().migrateTo('0013_hub_prefix_unique')).error).toBeUndefined()
    await seedHub()
    await withItem()
    await revision(1, 'n'.repeat(501))
    const { error } = await migrator().migrateToLatest()
    expect((error as Error).message).toBe(
      'revision.cause becomes a note of at most 500 characters (D63); 1 revisions have a longer one',
    )
    await sql`UPDATE revision SET cause = 'short'`.execute(db)
    expect(await migrateToLatest(db)).toEqual(['0014_revision_cause', '0015_item_external_key'])
  })

  describe('on the latest schema', () => {
    beforeEach(async () => {
      await migrateToLatest(db)
      await seedHub()
      await withItem()
      await revision(1, null)
    })

    it.each([
      ['a note', { note: 'n' }],
      ['500 characters of note', { note: 'é'.repeat(500) }],
      ['10 URLs of 2,048 characters', { evidence: Array(10).fill(`HTTPS://${'a'.repeat(2040)}`) }],
      ['an earlier revision', { causedBy: 1 }],
      ['every field', { note: 'n', evidence: ['http://e.example'], causedBy: 1 }],
    ])('accepts %s', async (_, cause) => {
      await revision(2, JSON.stringify(cause))
    })

    it.each([
      ['an empty object', {}],
      ['an array', ['n']],
      ['text', 'n'],
      ['an unknown key', { note: 'n', why: 'x' }],
      ['an empty note', { note: '' }],
      ['a note of 501 characters', { note: 'n'.repeat(501) }],
      ['a note that is not text', { note: 1 }],
      ['no evidence', { evidence: [] }],
      ['11 URLs', { evidence: Array(11).fill('https://e.example') }],
      ['a URL of 2,049 characters', { evidence: [`https://${'a'.repeat(2041)}`] }],
      ['another scheme', { evidence: ['ftp://e.example'] }],
      ['evidence that is not text', { evidence: [1] }],
      ['evidence that is not a list', { evidence: 'https://e.example' }],
      ['causedBy 0', { causedBy: 0 }],
      ['a fractional causedBy', { causedBy: 0.5 }],
      ['causedBy as text', { causedBy: '1' }],
      ['causedBy its own seq', { causedBy: 2 }],
      ['causedBy a later seq', { causedBy: 3 }],
    ])('refuses %s', async (_, cause) => {
      await expect(revision(2, JSON.stringify(cause))).rejects.toMatchObject({
        code: '23514',
        constraint: 'revision_cause_check',
      })
    })
  })
})

describe('0015_item_external_key', () => {
  const migrator = () =>
    new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })
  const item = (id: string, seq: number, key: string | null, hub = 'h1', folder = 'f1') =>
    sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by,
                          external_key)
        VALUES ('w1', ${id}, ${hub}, ${folder}, ${seq}, '{}', 'p1', ${key})`.execute(db)
  const columns = async () => {
    const { rows } = await sql<{ name: string }>`
      SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'item'
    `.execute(db)
    return rows.map((r) => r.name)
  }

  it('applies to a database migrated to 0014 with items, and migrates down and up again', async () => {
    expect((await migrator().migrateTo('0014_revision_cause')).error).toBeUndefined()
    await seedHub()
    await sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
              VALUES ('w1', 'i1', 'h1', 'f1', 1, '{"a":1}', 'p1')`.execute(db)

    expect(await migrateToLatest(db)).toEqual(['0015_item_external_key'])
    const keys = () =>
      db.selectFrom('item').select(['id', 'external_key', 'values']).orderBy('id').execute()
    expect(await keys()).toEqual([{ id: 'i1', external_key: null, values: { a: 1 } }])
    await item('i2', 2, 'src/app.ts')

    // Down drops the keys written since; the items stay.
    expect((await migrator().migrateTo('0014_revision_cause')).error).toBeUndefined()
    expect(await columns()).not.toContain('external_key')
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'item_external_key_key'
    `.execute(db)
    expect(rows[0]?.n).toBe(0)
    expect(await db.selectFrom('item').select('id').orderBy('id').execute()).toEqual([
      { id: 'i1' },
      { id: 'i2' },
    ])

    expect(await migrateToLatest(db)).toEqual(['0015_item_external_key'])
    expect((await keys()).map((r) => r.external_key)).toEqual([null, null])
    await item('i3', 3, 'src/app.ts')
  })

  describe('on the latest schema', () => {
    beforeEach(async () => {
      await migrateToLatest(db)
      await seedHub()
    })

    // Each key is checked by core and by the constraint, which must agree.
    const keys: [string, string, boolean][] = [
      ['a path', 'src/app.ts', true],
      ['one character', 'a', true],
      ['200 characters', 'k'.repeat(200), true],
      ['200 code points of 2 UTF-16 units each', '😀'.repeat(200), true],
      ['inner spaces', 'my file.ts', true],
      ['an inner line separator', 'a\u2028b', true],
      ['a zero-width space, which is not whitespace', '\u200ba', true],
      ['a key that differs only by case', 'SRC/APP.TS', true],
      ['empty', '', false],
      ['201 characters', 'k'.repeat(201), false],
      ['201 code points', '😀'.repeat(201), false],
      ['a leading space', ' a', false],
      ['a trailing space', 'a ', false],
      ['a leading no-break space', '\u00a0a', false],
      ['a trailing byte order mark', 'a\ufeff', false],
      ['a leading ideographic space', '\u3000a', false],
      ['a trailing line separator', 'a\u2028', false],
      ['a tab inside', 'a\tb', false],
      ['a newline inside', 'a\nb', false],
      ['DEL inside', 'a\u007fb', false],
      ['a C1 control inside', 'a\u0085b', false],
    ]

    it.each(keys)('agrees with core on %s', async (_, key, valid) => {
      expect(externalKeySchema.safeParse(key).success).toBe(valid)
      const insert = item('i1', 1, key)
      if (valid) await insert
      else {
        await expect(insert).rejects.toMatchObject({
          code: '23514',
          constraint: 'item_external_key_check',
        })
      }
    })

    it('makes a key unique per hub, compared exactly, and frees it with its item', async () => {
      await item('i1', 1, 'k')
      await expect(item('i2', 2, 'k', 'h1', 'h1')).rejects.toMatchObject({
        code: '23505',
        constraint: 'item_external_key_key',
      })
      // Another hub, another case, another normalisation, and no key are all fine.
      await item('i3', 1, 'k', 'h2', 'h2')
      await item('i4', 3, 'K')
      await item('i5', 4, '\u00c4')
      await item('i6', 5, 'A\u0308')
      await item('i7', 6, null)
      await item('i8', 7, null)
      await sql`DELETE FROM item WHERE workspace_id = 'w1' AND id = 'i1'`.execute(db)
      await item('i9', 8, 'k')
      await sql`UPDATE item SET external_key = NULL WHERE id = 'i9'`.execute(db)
      await sql`UPDATE item SET external_key = 'k' WHERE id = 'i7'`.execute(db)
    })

    it('allows the same key in another workspace', async () => {
      await item('i1', 1, 'k')
      await sql`INSERT INTO workspace (id, name) VALUES ('w2', 'Second')`.execute(db)
      await sql`INSERT INTO principal (workspace_id, id, kind, name, workspace_role)
                VALUES ('w2', 'p1', 'user', 'Owner', 'owner')`.execute(db)
      await sql`INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
                VALUES ('w2', 'h1', 'h1', NULL, 'Build', 'blue', 'BLD')`.execute(db)
      await sql`INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values,
                                  updated_by, external_key)
                VALUES ('w2', 'i1', 'h1', 'h1', 1, '{}', 'p1', 'k')`.execute(db)
    })

    it('lets the API role update the key, besides the columns it already updated', async () => {
      const { rows } = await sql<{ column: string }>`
        SELECT column_name AS column FROM information_schema.column_privileges
        WHERE table_name = 'item' AND grantee = 'sixteenbit_app' AND privilege_type = 'UPDATE'
        ORDER BY column_name
      `.execute(db)
      expect(rows.map((r) => r.column)).toEqual([
        'external_key',
        'updated_at',
        'updated_by',
        'values',
        'version',
      ])
    })
  })
})
