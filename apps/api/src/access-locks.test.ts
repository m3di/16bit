import type { Subject } from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkHub } from './access.ts'
import { appendAccessLog } from './access-log.ts'
import { createAgentKey, revokeAgentKey } from './agent-keys.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { withScope } from './db/scope.ts'
import { createTestDatabase } from './db/test-database.ts'
import { createItem, patchItem } from './items.ts'
import { HttpError } from './http.ts'
import { changeMemberRole, removeMember } from './members.ts'

// Lock order of concurrent access changes (#92, the comment at the top of members.ts), against
// a real Postgres under row-level security. Each test forces the interleaving that deadlocked:
// writer B takes the workspace row and is then held, by a gate, just before it inserts its log
// row; writer A takes its principal locks and waits for the workspace row; the gate opens and B
// inserts, which takes FOR KEY SHARE on its actor. Before the fix A held that actor FOR UPDATE,
// so Postgres aborted one of them with a deadlock (40P01, a 500). Now both commit.
//
// The gate is an uncommitted row with the sequence number B is about to take, inserted by the
// owner of the tables: B's insert waits on its unique key until the gate rolls back. Its actor
// is `gk`, who takes part in nothing else, so the gate holds no lock on anyone under test.

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
 * w1, hub `build` with attribute `title`, item `b1` (last written by own2) and item `b2` (last
 * written by ed).
 *   own   owner,  hub_admin on build     own2  owner, hub_admin on build
 *   adm   admin,  viewer on build        ed    member, editor on build
 *   gk    member, no grant (the gate's actor)
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
          ['gk', 'member'],
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
  await createItem(db, 'w1', 'ed', { id: 'b2', folderId: 'build', values: { title: 'Task' } })
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
       SELECT 'w1', next_access_seq, 'gk', 'gate-92', 'gk' FROM workspace WHERE id = 'w1'`,
    )
  } else {
    await client.query(
      `INSERT INTO revision (workspace_id, seq, item_id, version, patch, actor, hub_id)
       SELECT 'w1', next_revision_seq, 'gate-92', 1, '{"op":"create"}', 'gk', 'build'
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

type Result = Awaited<Run['done']>

/** Runs B up to the gate, then A until it waits, then opens the gate. Returns [B, A]. */
async function interleaveResults(
  gate: 'access_log' | 'revision',
  b: () => Run,
  a: () => Run,
): Promise<[Result, Result]> {
  const { open } = await openGate(gate)
  try {
    const first = b()
    await untilBlocked(first)
    const second = a()
    await untilBlocked(second)
    await open()
    return await Promise.all([first.done, second.done])
  } finally {
    await open()
  }
}

/** Like interleaveResults; both must commit. */
async function interleave(
  gate: 'access_log' | 'revision',
  b: () => Run,
  a: () => Run,
): Promise<void> {
  for (const r of await interleaveResults(gate, b, a)) {
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

  // The review of #95: with the target only NO KEY UPDATE locked, removal no longer waits for
  // an invite insert by the target at its first lock. It waits at the principal UPDATE (the
  // insert's foreign key holds the target FOR KEY SHARE), so the invites must be expired after
  // that UPDATE or the new invite stays redeemable.
  it('an admin creates an invite while an owner removes that admin', async () => {
    let inviteId = ''
    await interleave(
      'access_log',
      // What POST /invites does (auth/routes.ts): the invite, then its access_log row.
      () =>
        run('adm', async (trx) => {
          const row = await trx
            .insertInto('invite')
            .values({
              workspace_id: 'w1',
              id: 'inv-92',
              token_hash: 'hash-92',
              workspace_role: 'member',
              created_by: 'adm',
              expires_at: sql<Date>`now() + interval '7 days'`,
              used_at: null,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          inviteId = row.id
          await appendAccessLog(trx, {
            workspaceId: 'w1',
            actor: 'adm',
            action: 'invite.create',
            target: row.id,
          })
        }),
      () => run('own', (trx) => removeMember(trx, 'w1', own, 'adm')),
    )
    const invite = await db
      .selectFrom('invite')
      .select(sql<boolean>`expires_at <= now()`.as('expired'))
      .where('workspace_id', '=', 'w1')
      .where('id', '=', inviteId)
      .executeTakeFirstOrThrow()
    expect(invite.expired).toBe(true)
    const removal = await db
      .selectFrom('access_log')
      .select('detail')
      .where('workspace_id', '=', 'w1')
      .where('action', '=', 'member.remove')
      .executeTakeFirstOrThrow()
    expect(removal.detail).toMatchObject({ expiredInvites: ['inv-92'] })
  })

  // removeMember's principal UPDATE (FOR UPDATE) must come after the grant DELETE: the member's
  // own write holds its grant FOR SHARE and only references the member at its revision insert.
  // `b2` was last written by ed, so the item UPDATE takes no lock on ed before that insert.
  it("a member's own item write runs while an owner removes that member", async () => {
    await interleave(
      'revision',
      () =>
        run('ed', async (trx) => {
          const ed = subject('ed', 'member')
          await checkHub(trx, 'w1', ed, 'build', 'item.write', 'Item')
          await patchItem(trx, 'w1', 'ed', 'b2', { version: 1, values: { title: 'Done' } })
        }),
      () => run('own', (trx) => removeMember(trx, 'w1', own, 'ed')),
    )
    const item = await db
      .selectFrom('item')
      .select('version')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'b2')
      .executeTakeFirstOrThrow()
    expect(item.version).toBe(2)
    const ed = await db
      .selectFrom('principal')
      .select(sql<boolean>`removed_at IS NOT NULL`.as('removed'))
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'ed')
      .executeTakeFirstOrThrow()
    expect(ed.removed).toBe(true)
    expect(await accessLog()).toEqual([{ actor: 'own', action: 'member.remove', target: 'ed' }])
  })

  // The last-owner guarantee under NO KEY UPDATE: A waits on the owner rows B holds, then sees
  // B's demotion and refuses, because A's target is now the last owner.
  it('two owners demote each other: exactly one succeeds', async () => {
    const [b, a] = await interleaveResults(
      'access_log',
      () => run('own', (trx) => changeMemberRole(trx, 'w1', own, 'own2', 'admin')),
      () => run('own2', (trx) => changeMemberRole(trx, 'w1', own2, 'own', 'admin')),
    )
    expect(b).toEqual({ ok: true })
    expect(a.ok).toBe(false)
    if (!a.ok) {
      expect(a.error).toBeInstanceOf(HttpError)
      expect((a.error as HttpError).status).toBe(403)
    }
    const owners = await db
      .selectFrom('principal')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('workspace_role', '=', 'owner')
      .execute()
    expect(owners).toEqual([{ id: 'own' }])
    expect(await accessLog()).toEqual([{ actor: 'own', action: 'member.role', target: 'own2' }])
  })

  // An admin's access change whose log row lands after their removal committed: RLS now hides
  // the actor from the FOR KEY SHARE lock, which must fail loudly instead of locking nothing.
  it("an admin's access log append after their removal fails with a clear error", async () => {
    let release!: () => void
    const removed = new Promise<void>((resolve) => (release = resolve))
    const b = run('adm', async (trx) => {
      await removed
      await appendAccessLog(trx, {
        workspaceId: 'w1',
        actor: 'adm',
        action: 'key.revoke',
        target: 'adm',
      })
    })
    await b.pid
    const a = await run('own', (trx) => removeMember(trx, 'w1', own, 'adm')).done
    expect(a).toEqual({ ok: true })
    release()
    const result = await b.done
    expect(result.ok).toBe(false)
    if (!result.ok) expect(String(result.error)).toMatch(/actor adm cannot be locked/)
  })
})
