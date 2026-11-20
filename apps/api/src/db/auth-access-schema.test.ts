import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest, type Database } from './database.ts'
import { migrations } from './migrations/index.ts'
import { createTestDatabase } from './test-database.ts'

// Integration tests for 0003_auth_access (D42, D46, D47, D48) against a real Postgres.

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'

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

const migrator = () =>
  new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } })

/**
 * M0-shaped data, written with the 0001 schema only. (The demo seed can't run here any more: it
 * writes hub grants, which arrive in 0003.)
 */
async function seedAt0001(): Promise<void> {
  await sql`
    INSERT INTO workspace (id, name) VALUES ('demo', 'Demo'), ('acme', 'Acme');
    INSERT INTO principal (workspace_id, id, kind, name, workspace_role) VALUES
      ('demo', 'dev-owner', 'user', 'Dev', 'owner'),
      ('demo', 'bot', 'agent', 'Bot', 'member'),
      ('acme', 'dev-owner', 'user', 'Dev', 'owner');
    INSERT INTO folder (workspace_id, id, hub_id, parent_id, name, color, id_prefix)
      VALUES ('demo', 'h', 'h', NULL, 'Hub', 'blue', 'H');
  `.execute(db)
}

describe('upgrading a database already migrated with 0001', () => {
  it('keeps existing data and fills the new columns with defaults', async () => {
    const { error } = await migrator().migrateTo('0001_initial')
    expect(error).toBeUndefined()
    await seedAt0001()
    const before = await db.selectFrom('principal').select(['workspace_id', 'id', 'kind']).execute()
    expect(before.length).toBeGreaterThan(0)

    expect(await migrateToLatest(db)).toEqual([
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
    ])

    const principals = await db
      .selectFrom('principal')
      .select(['workspace_id', 'id', 'kind', 'account_id'])
      .execute()
    expect(principals).toHaveLength(before.length)
    expect(principals.every((p) => p.account_id === null)).toBe(true)
    const workspaces = await db.selectFrom('workspace').select('next_access_seq').execute()
    expect(workspaces.length).toBeGreaterThan(0)
    expect(workspaces.every((w) => w.next_access_seq === 1)).toBe(true)
  }, 30_000)

  it('migrates back down to 0001 and keeps the data', async () => {
    await migrator().migrateTo('0001_initial')
    await seedAt0001()
    const count = async () =>
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM principal`.execute(db)).rows[0]?.n)
    const before = await count()
    await migrateToLatest(db)

    const { error } = await migrator().migrateTo('0001_initial')
    expect(error).toBeUndefined()
    expect(await count()).toBe(before)
    const { rows } = await sql<{ name: string }>`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_name IN ('principal', 'workspace')
        AND column_name IN ('account_id', 'next_access_seq')
    `.execute(db)
    expect(rows).toEqual([])
  }, 30_000)
})

describe('auth and access constraints', () => {
  beforeEach(async () => {
    await migrateToLatest(db)
    await db.insertInto('workspace').values({ id: 'w1', name: 'Workspace' }).execute()
    await db
      .insertInto('account')
      .values({ id: 'acc1', email: 'ada@example.com', password_hash: HASH, name: 'Ada' })
      .execute()
    await db
      .insertInto('principal')
      .values([
        {
          workspace_id: 'w1',
          id: 'p1',
          kind: 'user',
          name: 'Ada',
          workspace_role: 'owner',
          account_id: 'acc1',
        },
        { workspace_id: 'w1', id: 'bot', kind: 'agent', name: 'Bot', workspace_role: 'member' },
      ])
      .execute()
    await db
      .insertInto('folder')
      .values([
        {
          workspace_id: 'w1',
          id: 'h1',
          hub_id: 'h1',
          parent_id: null,
          name: 'H1',
          color: 'blue',
          id_prefix: 'H',
        },
        {
          workspace_id: 'w1',
          id: 'h2',
          hub_id: 'h2',
          parent_id: null,
          name: 'H2',
          color: 'red',
          id_prefix: 'I',
        },
        {
          workspace_id: 'w1',
          id: 'f1',
          hub_id: 'h1',
          parent_id: 'h1',
          name: 'F1',
          color: 'blue',
          id_prefix: 'F',
        },
      ])
      .execute()
  })

  describe('account', () => {
    const account = (id: string, email: string, password_hash = HASH) =>
      db.insertInto('account').values({ id, email, password_hash, name: 'X' }).execute()

    it('rejects a duplicate email', async () => {
      await expect(account('acc2', 'ada@example.com')).rejects.toThrow(/account_email_key/)
    })

    it('rejects an email that is not trimmed and lowercased', async () => {
      await expect(account('acc2', 'Bob@example.com')).rejects.toThrow(/account_email_check/)
      await expect(account('acc2', ' bob@example.com')).rejects.toThrow(/account_email_check/)
      await expect(account('acc2', '')).rejects.toThrow(/account_email_check/)
    })

    it('rejects a password hash that is not argon2id', async () => {
      await expect(account('acc2', 'bob@example.com', '$2b$10$bcrypt')).rejects.toThrow(
        /account_password_hash_check/,
      )
      await expect(account('acc2', 'bob@example.com', 'plain')).rejects.toThrow(
        /account_password_hash_check/,
      )
    })
  })

  describe('session', () => {
    it('accepts a session and drops it with its account', async () => {
      await db
        .insertInto('account')
        .values({ id: 'acc2', email: 'bob@example.com', password_hash: HASH, name: 'Bob' })
        .execute()
      await db
        .insertInto('session')
        .values({ id_hash: 's1', account_id: 'acc2', expires_at: new Date(Date.now() + 60_000) })
        .execute()
      await db.deleteFrom('account').where('id', '=', 'acc2').execute()
      expect(await db.selectFrom('session').selectAll().execute()).toEqual([])
    })

    it('rejects an unknown account, a duplicate hash, and an expiry before creation', async () => {
      const later = new Date(Date.now() + 60_000)
      await expect(
        db
          .insertInto('session')
          .values({ id_hash: 's1', account_id: 'nope', expires_at: later })
          .execute(),
      ).rejects.toThrow(/foreign key/)
      await db
        .insertInto('session')
        .values({ id_hash: 's1', account_id: 'acc1', expires_at: later })
        .execute()
      await expect(
        db
          .insertInto('session')
          .values({ id_hash: 's1', account_id: 'acc1', expires_at: later })
          .execute(),
      ).rejects.toThrow(/session_pkey/)
      await expect(
        db
          .insertInto('session')
          .values({ id_hash: 's2', account_id: 'acc1', expires_at: new Date(Date.now() - 60_000) })
          .execute(),
      ).rejects.toThrow(/session_check/)
    })
  })

  describe('principal', () => {
    it('rejects an account on an agent', async () => {
      await expect(
        db.updateTable('principal').set({ account_id: 'acc1' }).where('id', '=', 'bot').execute(),
      ).rejects.toThrow(/principal_account_kind_check/)
    })

    it('rejects an agent with any workspace role but member', async () => {
      await expect(
        db
          .updateTable('principal')
          .set({ workspace_role: 'admin' })
          .where('id', '=', 'bot')
          .execute(),
      ).rejects.toThrow(/principal_agent_role_check/)
    })

    it('rejects a second principal for the same account in one workspace', async () => {
      await expect(
        db
          .insertInto('principal')
          .values({
            workspace_id: 'w1',
            id: 'p2',
            kind: 'user',
            name: 'Ada again',
            workspace_role: 'member',
            account_id: 'acc1',
          })
          .execute(),
      ).rejects.toThrow(/principal_workspace_account_key/)
    })

    it('allows the same account in another workspace', async () => {
      await db.insertInto('workspace').values({ id: 'w2', name: 'Other' }).execute()
      await db
        .insertInto('principal')
        .values({
          workspace_id: 'w2',
          id: 'p1',
          kind: 'user',
          name: 'Ada',
          workspace_role: 'viewer',
          account_id: 'acc1',
        })
        .execute()
      const rows = await db
        .selectFrom('principal')
        .select(['workspace_id', 'id', 'workspace_role'])
        .where('account_id', '=', 'acc1')
        .orderBy('workspace_id')
        .execute()
      expect(rows).toEqual([
        { workspace_id: 'w1', id: 'p1', workspace_role: 'owner' },
        { workspace_id: 'w2', id: 'p1', workspace_role: 'viewer' },
      ])
    })

    it('rejects an unknown account', async () => {
      await expect(
        db.updateTable('principal').set({ account_id: 'nope' }).where('id', '=', 'p1').execute(),
      ).rejects.toThrow(/principal_account_id_fkey/)
    })
  })

  describe('invite', () => {
    const invite = (
      row: Partial<{
        id: string
        token_hash: string
        workspace_role: string
        created_by: string
        used_at: Date
      }> = {},
    ) =>
      sql`
        INSERT INTO invite (workspace_id, id, token_hash, workspace_role, created_by, expires_at, used_at)
        VALUES ('w1', ${row.id ?? 'i1'}, ${row.token_hash ?? 't1'}, ${row.workspace_role ?? 'member'},
                ${row.created_by ?? 'p1'}, now() + interval '1 day', ${row.used_at ?? null})
      `.execute(db)

    it('accepts a valid invite and rejects a reused token hash', async () => {
      await invite()
      const row = await db.selectFrom('invite').selectAll().executeTakeFirstOrThrow()
      expect(row).toMatchObject({
        id: 'i1',
        token_hash: 't1',
        workspace_role: 'member',
        created_by: 'p1',
        used_at: null,
      })
      expect(row.created_at).toBeInstanceOf(Date)
      expect(Math.abs(row.created_at.getTime() - Date.now())).toBeLessThan(60_000)
      await expect(invite({ id: 'i2' })).rejects.toThrow(/invite_token_hash_key/)
    })

    it('rejects an unknown role, an unknown creator, and use after expiry', async () => {
      await expect(invite({ workspace_role: 'hub_admin' })).rejects.toThrow(
        /invite_workspace_role_check/,
      )
      await expect(invite({ created_by: 'nope' })).rejects.toThrow(/foreign key/)
      await expect(invite({ used_at: new Date(Date.now() + 2 * 86_400_000) })).rejects.toThrow(
        /invite_check/,
      )
    })
  })

  describe('agent_key', () => {
    it('accepts a key for an agent principal, with no expiry', async () => {
      await db
        .insertInto('agent_key')
        .values({
          workspace_id: 'w1',
          principal_id: 'bot',
          secret_hash: 'k1',
          created_by: 'p1',
          expires_at: null,
          revoked_at: null,
        })
        .execute()
      const key = await db.selectFrom('agent_key').selectAll().executeTakeFirstOrThrow()
      expect(key).toMatchObject({
        principal_kind: 'agent',
        created_by: 'p1',
        expires_at: null,
        revoked_at: null,
      })
      expect(key.created_at).toBeInstanceOf(Date)
      expect(Math.abs(key.created_at.getTime() - Date.now())).toBeLessThan(60_000)
    })

    it('rejects an unknown creator', async () => {
      await expect(
        db
          .insertInto('agent_key')
          .values({
            workspace_id: 'w1',
            principal_id: 'bot',
            secret_hash: 'k1',
            created_by: 'nope',
            expires_at: null,
            revoked_at: null,
          })
          .execute(),
      ).rejects.toThrow(/agent_key_workspace_id_created_by_fkey/)
    })

    it('rejects a key for a person', async () => {
      await expect(
        db
          .insertInto('agent_key')
          .values({
            workspace_id: 'w1',
            principal_id: 'p1',
            secret_hash: 'k1',
            created_by: 'p1',
            expires_at: null,
            revoked_at: null,
          })
          .execute(),
      ).rejects.toThrow(/foreign key/)
      await expect(
        sql`INSERT INTO agent_key (workspace_id, principal_id, principal_kind, secret_hash, created_by) VALUES ('w1', 'p1', 'user', 'k1', 'p1')`.execute(
          db,
        ),
      ).rejects.toThrow(/agent_key_principal_kind_check/)
    })

    it('rejects a second key for the same principal and a reused secret hash', async () => {
      await db
        .insertInto('principal')
        .values({
          workspace_id: 'w1',
          id: 'bot2',
          kind: 'agent',
          name: 'Bot 2',
          workspace_role: 'member',
        })
        .execute()
      const key = (principal_id: string, secret_hash: string) =>
        db
          .insertInto('agent_key')
          .values({
            workspace_id: 'w1',
            principal_id,
            secret_hash,
            created_by: 'p1',
            expires_at: null,
            revoked_at: null,
          })
          .execute()
      await key('bot', 'k1')
      await expect(key('bot', 'k2')).rejects.toThrow(/agent_key_pkey/)
      await expect(key('bot2', 'k1')).rejects.toThrow(/agent_key_secret_hash_key/)
    })
  })

  describe('hub_grant', () => {
    const grant = (
      hub_id: string,
      principal_id: string,
      hub_role: 'hub_admin' | 'editor' | 'commenter' | 'viewer',
      principal_kind: 'user' | 'agent' = 'user',
    ) =>
      db
        .insertInto('hub_grant')
        .values({ workspace_id: 'w1', hub_id, principal_id, principal_kind, hub_role })
        .execute()

    it('accepts grants on several hubs for a person', async () => {
      await grant('h1', 'p1', 'hub_admin')
      await grant('h2', 'p1', 'viewer')
      const rows = await db
        .selectFrom('hub_grant')
        .select(['hub_id', 'principal_kind', 'hub_role'])
        .where('principal_id', '=', 'p1')
        .orderBy('hub_id')
        .execute()
      expect(rows).toEqual([
        { hub_id: 'h1', principal_kind: 'user', hub_role: 'hub_admin' },
        { hub_id: 'h2', principal_kind: 'user', hub_role: 'viewer' },
      ])
    })

    it('rejects a grant on a folder that is not a hub', async () => {
      await expect(grant('f1', 'p1', 'editor')).rejects.toThrow(/foreign key/)
    })

    it('rejects an unknown hub role and a duplicate grant', async () => {
      await expect(
        sql`INSERT INTO hub_grant (workspace_id, hub_id, principal_id, hub_role) VALUES ('w1', 'h1', 'p1', 'owner')`.execute(
          db,
        ),
      ).rejects.toThrow(/hub_grant_hub_role_check/)
      await grant('h1', 'p1', 'editor')
      await expect(grant('h1', 'p1', 'viewer')).rejects.toThrow(/hub_grant_pkey/)
    })

    it('rejects a principal kind that does not match the principal', async () => {
      await expect(grant('h1', 'bot', 'editor')).rejects.toThrow(/foreign key/)
      await expect(grant('h1', 'p1', 'editor', 'agent')).rejects.toThrow(/foreign key/)
    })

    it('gives an agent at most one grant, never hub_admin', async () => {
      await expect(grant('h1', 'bot', 'hub_admin', 'agent')).rejects.toThrow(
        /hub_grant_agent_role_check/,
      )
      await grant('h1', 'bot', 'editor', 'agent')
      await expect(grant('h2', 'bot', 'viewer', 'agent')).rejects.toThrow(
        /hub_grant_one_per_agent_key/,
      )
    })
  })

  describe('access_log', () => {
    const log = (seq: number, actor = 'p1', detail = '{}') =>
      db
        .insertInto('access_log')
        .values({ workspace_id: 'w1', seq, actor, action: 'grant', target: 'h1', detail })
        .execute()

    it('accepts an entry and starts the workspace counter at 1', async () => {
      await log(1, 'p1', JSON.stringify({ role: 'editor', principal: 'p1' }))
      const ws = await db
        .selectFrom('workspace')
        .select('next_access_seq')
        .where('id', '=', 'w1')
        .executeTakeFirstOrThrow()
      expect(ws.next_access_seq).toBe(1)
    })

    it('rejects a duplicate seq, an unknown actor, an empty action, and non-object detail', async () => {
      await log(1)
      await expect(log(1)).rejects.toThrow(/access_log_pkey/)
      await expect(log(2, 'nope')).rejects.toThrow(/foreign key/)
      await expect(log(3, 'p1', '[]')).rejects.toThrow(/access_log_detail_check/)
      await expect(
        db
          .insertInto('access_log')
          .values({
            workspace_id: 'w1',
            seq: 4,
            actor: 'p1',
            action: '',
            target: 'h1',
            detail: '{}',
          })
          .execute(),
      ).rejects.toThrow(/access_log_action_check/)
    })
  })
})
