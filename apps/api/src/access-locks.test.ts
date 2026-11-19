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
import { revokeInvite } from './invites.ts'
import { changeMemberRole, createHub, removeMember } from './members.ts'

// Lock order of concurrent access changes (#92, #96, the comment at the top of members.ts),
// against a real Postgres under row-level security. Every test but the last forces an
// interleaving with a gate: writer B takes the workspace row and is then held, by the gate, just
// before it inserts its log or revision row; writer A runs until it waits on a lock; then the
// gate opens. In the #92 deadlock cases A waited for the workspace row while holding B's actor
// FOR UPDATE, which B's insert needs FOR KEY SHARE, so Postgres aborted one of them (40P01, a
// 500); now both commit. The other cases check what each side sees once it stops waiting. The
// last test holds its writer with a promise instead of a gate: it checks an error, not a lock.
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
type Trx = Transaction<Database>

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

const newHub = { id: 'h-96', name: 'Hub 96', color: 'blue', idPrefix: 'H' } as const

/** The 403 that `enforce` and a lost actor lock (#96) both throw. */
function expectForbidden(r: Result): void {
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error).toBeInstanceOf(HttpError)
    expect((r.error as HttpError).status).toBe(403)
  }
}

async function grantsOf(principalId: string) {
  return db
    .selectFrom('hub_grant')
    .select(['hub_id', 'hub_role'])
    .where('workspace_id', '=', 'w1')
    .where('principal_id', '=', principalId)
    .orderBy('hub_id')
    .execute()
}

async function removalDetail() {
  const row = await db
    .selectFrom('access_log')
    .select('detail')
    .where('workspace_id', '=', 'w1')
    .where('action', '=', 'member.remove')
    .executeTakeFirstOrThrow()
  return row.detail
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

// Removing a member expires their pending invites (#130). The removal holds the invite row from
// that UPDATE until it commits; a redeem waiting on that row then re-checks `expires_at > now()`
// with its own transaction's start time.
describe('a redeem racing the removal of the invite’s creator (#130)', () => {
  it('finds no invite when its transaction started first and it waited for the removal', async () => {
    await db
      .insertInto('invite')
      .values({
        workspace_id: 'w1',
        id: 'inv-130',
        token_hash: 'hash-130',
        workspace_role: 'member',
        created_by: 'adm',
        expires_at: sql<Date>`now() + interval '7 days'`,
      })
      .execute()
    await db
      .insertInto('account')
      .values({
        id: 'acct-130',
        email: 'acct-130@test.invalid',
        password_hash: `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
        name: 'New',
      })
      .execute()
    const { open } = await openGate('access_log')
    try {
      let go!: () => void
      const started = new Promise<void>((resolve) => (go = resolve))
      // What POST /v1/auth/invites/:token does for a signed-in account.
      const a = run('gk', async (trx) => {
        await started
        await sql`SELECT * FROM redeem_invite('hash-130', 'acct-130')`.execute(trx)
      })
      await a.pid // A's transaction, and so its now(), has started.
      const b = run('own', (trx) => removeMember(trx, 'w1', own, 'adm'))
      await untilBlocked(b) // At the gate, holding the expired invite.
      go()
      await untilBlocked(a) // On the invite row.
      await open()
      const [removed, redeemed] = await Promise.all([b.done, a.done])
      expect(removed).toEqual({ ok: true })
      expect(redeemed.ok).toBe(false)
      if (!redeemed.ok) expect((redeemed.error as { code?: unknown }).code).toBe('16B01')
    } finally {
      await open()
    }
    // The log names the invite as expired, and it is: unused, and nobody joined with it.
    expect(await removalDetail()).toMatchObject({ expiredInvites: ['inv-130'] })
    const invite = await db
      .selectFrom('invite')
      .select(['used_at', sql<boolean>`expires_at = created_at`.as('ended')])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'inv-130')
      .executeTakeFirstOrThrow()
    expect(invite).toEqual({ used_at: null, ended: true })
    const joined = await db
      .selectFrom('principal')
      .select('id')
      .where('account_id', '=', 'acct-130')
      .execute()
    expect(joined).toEqual([])
  })
})

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

  // #127: the same, demoting to member, and removing. A's owner lock passes RLS on its snapshot
  // from before B commits, then waits. Its next statement has a fresh snapshot in which own2 is
  // no longer an owner or admin, so the principal_update policy, which FOR NO KEY UPDATE must
  // pass, hid the target and A got 404. A now reads its own role after the owner lock: 403.
  // own2's hub_admin grant would also pass that policy (rls_hubs(4)), so it goes first.
  for (const [label, change] of [
    [
      'demote to member',
      (trx: Trx, actor: Subject, target: string) =>
        changeMemberRole(trx, 'w1', actor, target, 'member'),
    ],
    [
      'remove',
      (trx: Trx, actor: Subject, target: string) => removeMember(trx, 'w1', actor, target),
    ],
  ] as const) {
    it(`two owners ${label} each other: the second gets 403, not 404`, async () => {
      await db.deleteFrom('hub_grant').where('principal_id', '=', 'own2').execute()
      const [b, a] = await interleaveResults(
        'access_log',
        () => run('own', (trx) => change(trx, own, 'own2')),
        () => run('own2', (trx) => change(trx, own2, 'own')),
      )
      expect(b).toEqual({ ok: true })
      expectForbidden(a)
      const owners = await db
        .selectFrom('principal')
        .select('id')
        .where('workspace_id', '=', 'w1')
        .where('workspace_role', '=', 'owner')
        .where('removed_at', 'is', null)
        .execute()
      expect(owners).toEqual([{ id: 'own' }])
    })
  }

  // #127, an admin demoted while changing someone else's role. The demotion holds the owner
  // rows, so the admin's change waits there, then reads its new role and refuses.
  it('an admin whose demotion commits first gets 403 for a role change in flight', async () => {
    const [demotion, change] = await interleaveResults(
      'access_log',
      () => run('own', (trx) => changeMemberRole(trx, 'w1', own, 'adm', 'member')),
      () => run('adm', (trx) => changeMemberRole(trx, 'w1', adm, 'ed', 'viewer')),
    )
    expect(demotion).toEqual({ ok: true })
    expectForbidden(change)
    const ed = await db
      .selectFrom('principal')
      .select('workspace_role')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'ed')
      .executeTakeFirstOrThrow()
    expect(ed.workspace_role).toBe('member')
  })

  // #96, the creation first. createHub locks its creator FOR SHARE, so removal waits at its lock
  // on the target and its grant DELETE then sees the new grant. Without that lock, removal's NO
  // KEY UPDATE on adm doesn't wait, the DELETE misses the uncommitted grant, removal then waits
  // only at its principal UPDATE, and adm, removed, keeps hub_admin on the new hub.
  it('an admin creates a hub while an owner removes that admin', async () => {
    await interleave(
      'access_log',
      () => run('adm', (trx) => createHub(trx, 'w1', adm, newHub)),
      () => run('own', (trx) => removeMember(trx, 'w1', own, 'adm')),
    )
    const hub = await db
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'h-96')
      .executeTakeFirst()
    expect(hub).toEqual({ id: 'h-96' })
    expect(await grantsOf('adm')).toEqual([])
    expect(await removalDetail()).toMatchObject({
      revokedGrants: [
        { hubId: 'build', hubRole: 'viewer' },
        { hubId: 'h-96', hubRole: 'hub_admin' },
      ],
    })
  })

  // #96, the removal first (the opposite ordering). The creation waits for the removal at its
  // creator lock and then finds adm removed: 403, and no hub. Before #96 it waited at its
  // grant's foreign key instead, and appendAccessLog then failed with a plain Error, a 500.
  it('an admin whose removal commits first gets 403 for a hub creation in flight', async () => {
    const [removal, creation] = await interleaveResults(
      'access_log',
      () => run('own', (trx) => removeMember(trx, 'w1', own, 'adm')),
      () => run('adm', (trx) => createHub(trx, 'w1', adm, newHub)),
    )
    expect(removal).toEqual({ ok: true })
    expectForbidden(creation)
    const hub = await db
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'h-96')
      .executeTakeFirst()
    expect(hub).toBeUndefined()
    expect(await grantsOf('adm')).toEqual([])
  })

  // #96 review, a demotion that commits first. changeMemberRole holds adm FOR NO KEY UPDATE, so
  // the creation waits at its creator lock, then reads adm's new role on the locked row and
  // refuses: 403, and no hub. Without the role check the lock passes (adm is not removed) and
  // the folder insert fails RLS on its fresh snapshot, a 500.
  it('an admin whose demotion commits first gets 403 for a hub creation in flight', async () => {
    const [demotion, creation] = await interleaveResults(
      'access_log',
      () => run('own', (trx) => changeMemberRole(trx, 'w1', own, 'adm', 'member')),
      () => run('adm', (trx) => createHub(trx, 'w1', adm, newHub)),
    )
    expect(demotion).toEqual({ ok: true })
    expectForbidden(creation)
    const hub = await db
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'h-96')
      .executeTakeFirst()
    expect(hub).toBeUndefined()
    expect(await grantsOf('adm')).toEqual([{ hub_id: 'build', hub_role: 'viewer' }])
  })

  // #96, an invite insert by adm whose removal commits first. The insert's RLS check passes on
  // its snapshot from before the removal, and its foreign key waits for the removal and then
  // passes, since the principal row stays. appendAccessLog stops it: RLS now hides adm from the
  // actor lock. That is a 403 and the invite rolls back; before #96 it was a 500.
  it('an admin whose removal commits first gets 403 for an invite in flight', async () => {
    const [removal, invite] = await interleaveResults(
      'access_log',
      () => run('own', (trx) => removeMember(trx, 'w1', own, 'adm')),
      // What POST /invites does (auth/routes.ts): the invite, then its access_log row.
      () =>
        run('adm', async (trx) => {
          await trx
            .insertInto('invite')
            .values({
              workspace_id: 'w1',
              id: 'inv-96',
              token_hash: 'hash-96',
              workspace_role: 'member',
              created_by: 'adm',
              expires_at: sql<Date>`now() + interval '7 days'`,
              used_at: null,
            })
            .execute()
          await appendAccessLog(trx, {
            workspaceId: 'w1',
            actor: 'adm',
            action: 'invite.create',
            target: 'inv-96',
          })
        }),
    )
    expect(removal).toEqual({ ok: true })
    expectForbidden(invite)
    const row = await db
      .selectFrom('invite')
      .select('id')
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'inv-96')
      .executeTakeFirst()
    expect(row).toBeUndefined()
  })

  // An admin's access change whose log row lands after their removal committed: RLS now hides
  // the actor from the FOR KEY SHARE lock, which must refuse instead of locking nothing: a 403,
  // since the actor lost the right to the change while it was in flight (#96).
  it("an admin's access log append after their removal gets 403", async () => {
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
    expectForbidden(await b.done)
  })
})

// Revoking an invite (#113, invites.ts): it locks its actor FOR SHARE, then the invite FOR UPDATE,
// then appends to access_log, and ends the invite by setting expires_at to created_at.
describe('concurrent invite revocations (#113)', () => {
  /** A pending member invite from `own`, with a known token hash. */
  async function pendingInvite() {
    await db
      .insertInto('invite')
      .values({
        workspace_id: 'w1',
        id: 'inv-113',
        token_hash: 'hash-113',
        workspace_role: 'member',
        created_by: 'own',
        expires_at: sql<Date>`now() + interval '7 days'`,
        used_at: null,
      })
      .execute()
  }

  /** An account in no workspace, to redeem with. No password matches its hash. */
  async function account() {
    await db
      .insertInto('account')
      .values({
        id: 'acct-113',
        email: 'acct-113@test.invalid',
        password_hash: `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
        name: 'New',
      })
      .execute()
  }

  async function inviteState() {
    return db
      .selectFrom('invite')
      .select([
        'used_at',
        'expires_at',
        sql<boolean>`used_at IS NULL AND expires_at > now()`.as('pending'),
      ])
      .where('workspace_id', '=', 'w1')
      .where('id', '=', 'inv-113')
      .executeTakeFirstOrThrow()
  }

  const revocations = () =>
    db
      .selectFrom('access_log')
      .select(['actor', 'target'])
      .where('workspace_id', '=', 'w1')
      .where('action', '=', 'invite.revoke')
      .execute()

  /** What POST /v1/auth/invites/:token does for a signed-in account. */
  const redeem = (trx: Transaction<Database>) =>
    sql`SELECT * FROM redeem_invite('hash-113', 'acct-113')`.execute(trx)

  // The redeem's transaction starts before the revoke's, then waits on the invite row the revoke
  // holds. redeem_invite checks `expires_at > now()` with its own, earlier, start time, so a
  // revoke that set `expires_at = now()` would let this redeem through once it committed. With
  // `expires_at = created_at` the redeem finds no invite: 16B01, a 404.
  it('a redeem that started before a revoke and waited for it finds no invite', async () => {
    await pendingInvite()
    await account()
    const { open } = await openGate('access_log')
    try {
      let go!: () => void
      const started = new Promise<void>((resolve) => (go = resolve))
      const a = run('gk', async (trx) => {
        await started
        await redeem(trx)
      })
      await a.pid // A's transaction, and so its now(), has started.
      const b = run('own', (trx) => revokeInvite(trx, 'w1', own, 'inv-113'))
      await untilBlocked(b) // At the gate, holding the invite.
      go()
      await untilBlocked(a) // On the invite row.
      await open()
      const [revoked, redeemed] = await Promise.all([b.done, a.done])
      expect(revoked).toEqual({ ok: true })
      expect(redeemed.ok).toBe(false)
      if (!redeemed.ok) expect((redeemed.error as { code?: unknown }).code).toBe('16B01')
    } finally {
      await open()
    }
    expect((await inviteState()).used_at).toBeNull()
    expect(await revocations()).toEqual([{ actor: 'own', target: 'inv-113' }])
    const joined = await db
      .selectFrom('principal')
      .select('id')
      .where('account_id', '=', 'acct-113')
      .execute()
    expect(joined).toEqual([])
  })

  // The revoke waits on a redeem that holds the invite (held at the gate before its member.join
  // log row). Once the redeem commits, the revoke re-reads the row: no longer pending, so it
  // changes nothing and logs nothing (a 204).
  it('a revoke that waited for a redeem to commit changes and logs nothing', async () => {
    await pendingInvite()
    await account()
    const before = await inviteState()
    const [redeemed, revoked] = await interleaveResults(
      'access_log',
      () => run('gk', redeem),
      () => run('own', (trx) => revokeInvite(trx, 'w1', own, 'inv-113')),
    )
    expect(redeemed).toEqual({ ok: true })
    expect(revoked).toEqual({ ok: true })
    const after = await inviteState()
    expect(after.used_at).not.toBeNull()
    expect(after.expires_at).toEqual(before.expires_at)
    expect(await revocations()).toEqual([])
  })

  // The admin's demotion or removal holds adm FOR NO KEY UPDATE, so the revoke waits at its actor
  // lock, then reads adm's new role (or finds adm removed) on the locked row and refuses: 403, no
  // log row, and the invite stays pending. The early check had passed on the stale role.
  const changes = [
    ['demotion', (trx: Transaction<Database>) => changeMemberRole(trx, 'w1', own, 'adm', 'member')],
    ['removal', (trx: Transaction<Database>) => removeMember(trx, 'w1', own, 'adm')],
  ] as const
  for (const [change, b] of changes) {
    it(`an admin whose ${change} commits first gets 403 for a revoke in flight`, async () => {
      await pendingInvite()
      const [changed, revoked] = await interleaveResults(
        'access_log',
        () => run('own', b),
        () => run('adm', (trx) => revokeInvite(trx, 'w1', adm, 'inv-113')),
      )
      expect(changed).toEqual({ ok: true })
      expectForbidden(revoked)
      expect((await inviteState()).pending).toBe(true)
      expect(await revocations()).toEqual([])
    })
  }
})
