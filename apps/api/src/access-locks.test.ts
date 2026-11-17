import type { Subject } from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkHub } from './access.ts'
import { createAgentKey, revokeAgentKey } from './agent-keys.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { withScope } from './db/scope.ts'
import { createTestDatabase } from './db/test-database.ts'
import { createItem, patchItem } from './items.ts'
import { changeMemberRole, removeMember } from './members.ts'

// Lock order of concurrent access changes (#92, the comment at the top of members.ts), against
// a real Postgres under row-level security. Each test forces the interleaving that deadlocked:
// writer B takes the workspace row and is then held, by a gate, just before it inserts its log
// row; writer A takes its principal locks and waits for the workspace row; the gate opens and B
// inserts, which takes FOR KEY SHARE on its actor. Before the fix A held that actor FOR UPDATE,
// so Postgres aborted one of them with a deadlock (40P01, a 500). Now both commit.
//
// The gate is an uncommitted row with the sequence number B is about to take, inserted by the
// owner of the tables: B's insert waits on its unique key until the gate rolls back.

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let ownerUrl: string
let drop: () => Promise<void>

const subject = (id: string, workspaceRole: Subject['workspaceRole']): Subject => ({
  id,
  kind: 'user',
  workspaceRole,
})
const own = subject('own', 'owner')
const own2 = subject('own2', 'owner')
const adm = subject('adm', 'admin')

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  ownerUrl = test.url
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
})

afterEach(async () => {
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * w1, hub `build` with attribute `title` and item `b1` (last written by own2).
 *   own   owner,  hub_admin on build     own2  owner, hub_admin on build
 *   adm   admin,  viewer on build        ed    member, editor on build
 */
async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: 'w1', name: 'Alpha' }).execute()
  await db
    .insertInto('principal')
    .values(
      (
        [
          ['own', 'owner'],
          ['own2', 'owner'],
          ['adm', 'admin'],
          ['ed', 'member'],
        ] as const
      ).map(([id, workspace_role]) => ({
        workspace_id: 'w1',
        id,
        kind: 'user' as const,
        name: id,
        workspace_role,
      })),
    )
    .execute()
  await db
    .insertInto('folder')
    .values({
      workspace_id: 'w1',
      id: 'build',
      hub_id: 'build',
      parent_id: null,
      name: 'Build',
      color: 'blue',
      id_prefix: 'B',
    })
    .execute()
  await db
    .insertInto('attribute')
    .values({
      workspace_id: 'w1',
      id: 'title',
      hub_id: 'build',
      name: 'Title',
      type: 'text',
      config: {},
    })
    .execute()
  await db
    .insertInto('folder_attribute')
    .values({
      workspace_id: 'w1',
      hub_id: 'build',
      folder_id: 'build',
      attribute_id: 'title',
      position: 0,
      required: false,
    })
    .execute()
  await db
    .insertInto('hub_grant')
    .values(
      (
        [
          ['own', 'hub_admin'],
          ['own2', 'hub_admin'],
          ['adm', 'viewer'],
          ['ed', 'editor'],
        ] as const
      ).map(([principal_id, hub_role]) => ({
        workspace_id: 'w1',
        hub_id: 'build',
        principal_id,
        hub_role,
      })),
    )
    .execute()
  await createItem(db, 'w1', 'own2', { id: 'b1', folderId: 'build', values: { title: 'Bug' } })
}

async function newKey(): Promise<string> {
  const created = await createAgentKey(db, 'w1', own, 'build', {
    name: 'bot',
    hubRole: 'editor',
    expiresAt: null,
  })
  return created.key.id
}

/** An uncommitted row holding the next `access_log` or `revision` seq of w1, as the owner. */
async function openGate(table: 'access_log' | 'revision'): Promise<{ open: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  await client.query('BEGIN')
  if (table === 'access_log') {
    await client.query(
      `INSERT INTO access_log (workspace_id, seq, actor, action, target)
       SELECT 'w1', next_access_seq, 'ed', 'gate-92', 'ed' FROM workspace WHERE id = 'w1'`,
    )
  } else {
    await client.query(
      `INSERT INTO revision (workspace_id, seq, item_id, version, patch, actor, hub_id)
       SELECT 'w1', next_revision_seq, 'gate-92', 1, '{"op":"create"}', 'ed', 'build'
       FROM workspace WHERE id = 'w1'`,
    )
  }
  let opened = false
  return {
    open: async () => {
      if (opened) return
      opened = true
      await client.query('ROLLBACK')
      await client.end()
    },
  }
}

interface Run {
  /** Settles with the transaction. Never rejects, so a deadlock shows up in the assertion. */
  done: Promise<{ ok: true } | { ok: false; error: unknown }>
  pid: Promise<number>
}

/** Runs `fn` as `principalId` in its own scoped transaction (its own connection). */
function run(principalId: string, fn: (trx: Transaction<Database>) => Promise<unknown>): Run {
  let setPid!: (pid: number) => void
  const pid = new Promise<number>((resolve) => (setPid = resolve))
  const done = withScope(appDb, { workspaceId: 'w1', principalId }, async (trx) => {
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
    const [row] = rows
    if (!row) throw new Error('no backend pid')
    setPid(row.pid)
    await fn(trx)
  }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  return { done, pid }
}

/** Resolves once `r` waits on a lock, or has finished. */
async function untilBlocked(r: Run): Promise<void> {
  const pid = await r.pid
  const state = { finished: false }
  void r.done.then(() => (state.finished = true))
  for (let i = 0; i < 500 && !state.finished; i++) {
    const { rows } = await sql<{ waiting: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND NOT granted) AS waiting
    `.execute(db)
    if (rows[0]?.waiting) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!state.finished) throw new Error(`backend ${String(pid)} never waited on a lock`)
}

/** Runs B up to the gate, then A until it waits, then opens the gate. Both must commit. */
async function interleave(
  gate: 'access_log' | 'revision',
  b: () => Run,
  a: () => Run,
): Promise<void> {
  const { open } = await openGate(gate)
  let results
  try {
    const first = b()
    await untilBlocked(first)
    const second = a()
    await untilBlocked(second)
    await open()
    results = await Promise.all([first.done, second.done])
  } finally {
    await open()
  }
  for (const r of results) {
    if (!r.ok) throw r.error
  }
}

async function accessLog() {
  return db
    .selectFrom('access_log')
    .select(['actor', 'action', 'target'])
    .where('workspace_id', '=', 'w1')
    .where('action', 'in', ['key.revoke', 'member.role', 'member.remove'])
    .orderBy('seq')
    .execute()
}

describe('concurrent access changes (#92)', () => {
  it('an owner revokes a key while another owner changes a member role', async () => {
    const keyId = await newKey()
    await interleave(
      'access_log',
      () => run('own', (trx) => revokeAgentKey(trx, 'w1', own, keyId)),
      () => run('own2', (trx) => changeMemberRole(trx, 'w1', own2, 'ed', 'admin')),
    )
    expect(await accessLog()).toEqual([
      { actor: 'own', action: 'key.revoke', target: keyId },
      { actor: 'own2', action: 'member.role', target: 'ed' },
    ])
    const ed = await db
      .selectFrom('principal')
      .select('workspace_role')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'ed')
      .executeTakeFirstOrThrow()
    expect(ed.workspace_role).toBe('admin')
  })

  it('an admin revokes a key while an owner removes that admin', async () => {
    const keyId = await newKey()
    await interleave(
      'access_log',
      () => run('adm', (trx) => revokeAgentKey(trx, 'w1', adm, keyId)),
      () => run('own', (trx) => removeMember(trx, 'w1', own, 'adm')),
    )
    expect(await accessLog()).toEqual([
      { actor: 'adm', action: 'key.revoke', target: keyId },
      { actor: 'own', action: 'member.remove', target: 'adm' },
    ])
  })

  it("an owner's item write runs while another owner changes a member role", async () => {
    await interleave(
      'revision',
      () =>
        run('own2', async (trx) => {
          await checkHub(trx, 'w1', own2, 'build', 'item.write', 'Item')
          await patchItem(trx, 'w1', 'own2', 'b1', { version: 1, values: { title: 'Fixed' } })
        }),
      () => run('own', (trx) => changeMemberRole(trx, 'w1', own, 'ed', 'viewer')),
    )
    const item = await db
      .selectFrom('item')
      .select('version')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'b1')
      .executeTakeFirstOrThrow()
    expect(item.version).toBe(2)
    expect(await accessLog()).toEqual([{ actor: 'own', action: 'member.role', target: 'ed' }])
  })
})
