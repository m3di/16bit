import {
  acceptedInviteSchema,
  createdInviteSchema,
  meSchema,
  workspacePageSchema,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppOptions } from '../app.ts'
import { createDb, migrateToLatest, type Database } from '../db/database.ts'
import { createTestDatabase } from '../db/test-database.ts'
import { resetPassword } from '../reset-password.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { hashToken } from './session.ts'

// Integration tests for sign-in, sessions and invites (#41) against a fresh Postgres per test.

const KEY = 'test-key'
const DEV = 'dev-owner'
const PASSWORD = 'correct horse battery'
const dev = { authorization: `Bearer ${KEY}` }
const crossSite = { 'sec-fetch-site': 'cross-site' }

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let passwordHash: string

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD)
})

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  app = build()
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

const build = (options: Partial<AppOptions> = {}) =>
  buildApp({ db: appDb, devDb: db, devApiKey: KEY, devPrincipalId: DEV, ...options })

/**
 * w1 "Alpha": alice owner, bob admin, carol member, plus the dev owner.
 * w2 "Beta": only the dev owner. dave has an account and no workspace.
 */
async function seed(): Promise<void> {
  await db
    .insertInto('workspace')
    .values([
      { id: 'w1', name: 'Alpha' },
      { id: 'w2', name: 'Beta' },
    ])
    .execute()
  const accounts = ['alice', 'bob', 'carol', 'dave']
  await db
    .insertInto('account')
    .values(
      accounts.map((id) => ({
        id,
        email: `${id}@example.com`,
        password_hash: passwordHash,
        name: id,
      })),
    )
    .execute()
  const person = (workspace_id: string, id: string, role: 'owner' | 'admin' | 'member') => ({
    workspace_id,
    id: `p-${id}`,
    kind: 'user' as const,
    name: id,
    workspace_role: role,
    account_id: id,
  })
  await db
    .insertInto('principal')
    .values([
      person('w1', 'alice', 'owner'),
      person('w1', 'bob', 'admin'),
      person('w1', 'carol', 'member'),
      { workspace_id: 'w1', id: DEV, kind: 'user', name: 'Dev', workspace_role: 'owner' },
      { workspace_id: 'w2', id: DEV, kind: 'user', name: 'Dev', workspace_role: 'owner' },
    ])
    .execute()
}

async function login(email: string, password = PASSWORD, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
    headers,
  })
}

/** Signs in and returns the `cookie` header to send back. */
async function session(email: string): Promise<{ cookie: string }> {
  const res = await login(email)
  expect(res.statusCode).toBe(200)
  return { cookie: cookieOf(res.headers['set-cookie']) }
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const pair = value?.split(';')[0]
  if (!pair) throw new Error('no Set-Cookie')
  return pair
}

const tokenOf = (cookie: string) => cookie.slice('sid='.length)

async function createInvite(
  headers: Record<string, string>,
  workspaceId = 'w1',
  workspaceRole = 'member',
) {
  return app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/invites`,
    headers,
    payload: { workspaceRole },
  })
}

async function inviteToken(workspaceId = 'w1', workspaceRole = 'member'): Promise<string> {
  const res = await createInvite(dev, workspaceId, workspaceRole)
  expect(res.statusCode).toBe(201)
  return createdInviteSchema.parse(res.json()).token
}

const accept = (token: string, payload: object = {}, headers = {}) =>
  app.inject({ method: 'POST', url: `/v1/auth/invites/${token}`, payload, headers })

/** Resolves once another connection to this database is blocked on a lock. */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `.execute(db)
    if ((rows[0]?.n ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('no connection waited on a lock')
}

const newAccount = { name: 'Erin', email: 'Erin@Example.com ', password: 'a long new password' }

describe('POST /v1/auth/login', () => {
  it('starts a session in an httpOnly, SameSite=Lax cookie and returns the account', async () => {
    const res = await login('alice@example.com')
    expect(res.statusCode).toBe(200)
    const me = meSchema.parse(res.json())
    expect(me).toEqual({
      kind: 'person',
      account: { id: 'alice', email: 'alice@example.com', name: 'alice' },
      memberships: [
        { workspace: { id: 'w1', name: 'Alpha' }, principalId: 'p-alice', workspaceRole: 'owner' },
      ],
      truncated: false,
    })

    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toMatch(/^sid=[A-Za-z0-9_-]{43}; /)
    for (const attr of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=2592000']) {
      expect(setCookie.split('; ')).toContain(attr)
    }

    // Only the token's hash is stored, with a 30-day absolute expiry.
    const token = tokenOf(cookieOf(res.headers['set-cookie']))
    const row = await db
      .selectFrom('session')
      .select([
        'id_hash',
        'account_id',
        sql<string>`extract(epoch from expires_at - created_at)`.as('life'),
      ])
      .executeTakeFirstOrThrow()
    expect(row.id_hash).toBe(hashToken(token))
    expect(row.id_hash).not.toBe(token)
    expect(row.account_id).toBe('alice')
    expect(Number(row.life)).toBe(30 * 24 * 3600)
  })

  it('leaves Secure off only when configured for plain-HTTP development', async () => {
    app = build({ secureCookies: false })
    const res = await login('alice@example.com')
    expect(String(res.headers['set-cookie']).split('; ')).not.toContain('Secure')
  })

  it('accepts the email in any case and with surrounding spaces', async () => {
    expect((await login('  ALICE@example.COM ')).statusCode).toBe(200)
  })

  it('gives a wrong password and an unknown email the same 401', async () => {
    const wrong = await login('alice@example.com', 'not the password')
    const unknown = await login('nobody@example.com')
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.json()).toEqual(unknown.json())
    expect(wrong.json()).toEqual({
      error: 'unauthorized',
      message: 'Email or password is incorrect',
    })
    expect(wrong.headers['set-cookie']).toBeUndefined()
    expect(await db.selectFrom('session').select('id_hash').execute()).toEqual([])
  })

  it('rejects a malformed body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('rate-limits per email, for unknown emails too, even with the right password', async () => {
    app = build({ loginPerEmail: { max: 2, windowSeconds: 60 } })
    expect((await login('alice@example.com', 'wrong')).statusCode).toBe(401)
    expect((await login('alice@example.com', 'wrong')).statusCode).toBe(401)
    const limited = await login('alice@example.com')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: 'rate_limited' })
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)

    await login('ghost@example.com', 'x')
    await login('ghost@example.com', 'x')
    const ghost = await login('ghost@example.com', 'x')
    expect(ghost.statusCode).toBe(429)
    expect(ghost.json()).toEqual(limited.json())

    // Another email is not affected.
    expect((await login('bob@example.com')).statusCode).toBe(200)
  })

  it('rate-limits per client IP across emails', async () => {
    app = build({ loginPerIp: { max: 3, windowSeconds: 60 } })
    for (const who of ['a', 'b', 'c']) await login(`${who}@example.com`, 'x')
    expect((await login('alice@example.com')).statusCode).toBe(429)
  })

  it('rotates the session: signing in again ends the one the request came with', async () => {
    const first = await session('alice@example.com')
    const res = await login('alice@example.com', PASSWORD, first)
    expect(res.statusCode).toBe(200)
    const second = cookieOf(res.headers['set-cookie'])
    expect(second).not.toBe(first.cookie)

    const hashes = await db.selectFrom('session').select('id_hash').execute()
    expect(hashes).toEqual([{ id_hash: hashToken(tokenOf(second)) }])
    expect((await app.inject({ url: '/v1/me', headers: first })).statusCode).toBe(401)
  })

  it('refuses cross-site sign-in (login CSRF)', async () => {
    const res = await login('alice@example.com', PASSWORD, crossSite)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'forbidden' })
    const foreign = await login('alice@example.com', PASSWORD, { origin: 'https://evil.example' })
    expect(foreign.statusCode).toBe(403)
    const same = await login('alice@example.com', PASSWORD, { 'sec-fetch-site': 'same-origin' })
    expect(same.statusCode).toBe(200)
    const origin = await login('alice@example.com', PASSWORD, {
      origin: 'https://app.test',
      host: 'app.test',
    })
    expect(origin.statusCode).toBe(200)
  })
})

describe('sessions', () => {
  it('GET /v1/me returns the signed-in account', async () => {
    const res = await app.inject({ url: '/v1/me', headers: await session('bob@example.com') })
    expect(res.statusCode).toBe(200)
    expect(meSchema.parse(res.json())).toMatchObject({
      kind: 'person',
      account: { id: 'bob' },
      memberships: [{ principalId: 'p-bob', workspaceRole: 'admin' }],
    })
  })

  it('GET /v1/me is 401 without credentials, with a bad cookie, and for the dev key', async () => {
    expect((await app.inject({ url: '/v1/me' })).statusCode).toBe(401)
    const bad = await app.inject({ url: '/v1/me', headers: { cookie: 'sid=nope' } })
    expect(bad.statusCode).toBe(401)
    const devMe = await app.inject({ url: '/v1/me', headers: dev })
    expect(devMe.statusCode).toBe(401)
    expect(devMe.json()).toMatchObject({ error: 'unauthorized' })
  })

  it('a session acts as the account’s principal in the workspace of the path', async () => {
    const carol = await session('carol@example.com')
    const list = await app.inject({ url: '/v1/workspaces', headers: carol })
    expect(workspacePageSchema.parse(list.json()).items.map((w) => w.id)).toEqual(['w1'])
    expect((await app.inject({ url: '/v1/workspaces/w1/hubs', headers: carol })).statusCode).toBe(
      200,
    )
    // Not a member of w2: it does not exist for carol.
    const hidden = await app.inject({ url: '/v1/workspaces/w2/hubs', headers: carol })
    expect(hidden.statusCode).toBe(404)
  })

  it('pages the workspace list of a session', async () => {
    await db
      .insertInto('principal')
      .values({
        workspace_id: 'w2',
        id: 'p-alice-2',
        kind: 'user',
        name: 'alice',
        workspace_role: 'member',
        account_id: 'alice',
      })
      .execute()
    const alice = await session('alice@example.com')
    const first = workspacePageSchema.parse(
      (await app.inject({ url: '/v1/workspaces?limit=1', headers: alice })).json(),
    )
    expect(first.items.map((w) => w.id)).toEqual(['w1'])
    const second = workspacePageSchema.parse(
      (
        await app.inject({
          url: `/v1/workspaces?limit=1&cursor=${first.nextCursor ?? ''}`,
          headers: alice,
        })
      ).json(),
    )
    expect(second).toMatchObject({ items: [{ id: 'w2', name: 'Beta' }], nextCursor: null })
    // The creation time comes from account_memberships, not a direct read of workspace.
    const created = await db
      .selectFrom('workspace')
      .select('created_at')
      .where('id', '=', 'w2')
      .executeTakeFirstOrThrow()
    expect(second.items[0]?.createdAt).toBe(created.created_at.toISOString())
  })

  it('ends after the idle timeout', async () => {
    const alice = await session('alice@example.com')
    await db
      .updateTable('session')
      .set({ last_seen_at: sql`now() - interval '8 days'` })
      .execute()
    expect((await app.inject({ url: '/v1/me', headers: alice })).statusCode).toBe(401)
  })

  it('ends at its absolute expiry even when in use', async () => {
    const alice = await session('alice@example.com')
    await db
      .updateTable('session')
      .set({
        created_at: sql`now() - interval '31 days'`,
        expires_at: sql`now() - interval '1 second'`,
      })
      .execute()
    expect((await app.inject({ url: '/v1/me', headers: alice })).statusCode).toBe(401)
  })

  it('refreshes last_seen_at on use, at most once a minute', async () => {
    const alice = await session('alice@example.com')
    await db
      .updateTable('session')
      .set({ last_seen_at: sql`now() - interval '5 minutes'` })
      .execute()
    expect((await app.inject({ url: '/v1/me', headers: alice })).statusCode).toBe(200)
    const { recent } = await db
      .selectFrom('session')
      .select(sql<boolean>`last_seen_at > now() - interval '1 minute'`.as('recent'))
      .executeTakeFirstOrThrow()
    expect(recent).toBe(true)
  })

  it('refuses cookie-authenticated writes from another site, allows same-origin ones', async () => {
    const alice = await session('alice@example.com')
    const cross = await createInvite({ ...alice, ...crossSite })
    expect(cross.statusCode).toBe(403)
    expect(await db.selectFrom('invite').select('id').execute()).toEqual([])

    const same = await createInvite({ ...alice, 'sec-fetch-site': 'same-origin' })
    expect(same.statusCode).toBe(201)
    // Reads are not affected.
    const read = await app.inject({ url: '/v1/me', headers: { ...alice, ...crossSite } })
    expect(read.statusCode).toBe(200)
  })

  it('does not apply the CSRF guard to bearer-authenticated writes', async () => {
    expect((await createInvite({ ...dev, ...crossSite })).statusCode).toBe(201)
  })
})

describe('POST /v1/auth/logout', () => {
  it('ends the session and clears the cookie', async () => {
    const alice = await session('alice@example.com')
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: alice })
    expect(res.statusCode).toBe(204)
    expect(String(res.headers['set-cookie'])).toMatch(/^sid=; .*Max-Age=0/)
    expect(await db.selectFrom('session').select('id_hash').execute()).toEqual([])
    expect((await app.inject({ url: '/v1/me', headers: alice })).statusCode).toBe(401)
  })

  it('is a 204 without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout' })
    expect(res.statusCode).toBe(204)
  })

  it('refuses a cross-site sign-out', async () => {
    const alice = await session('alice@example.com')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { ...alice, ...crossSite },
    })
    expect(res.statusCode).toBe(403)
    expect((await app.inject({ url: '/v1/me', headers: alice })).statusCode).toBe(200)
  })
})

describe('POST /v1/workspaces/:workspaceId/invites', () => {
  it('lets an owner create an invite, stores only the token hash, and logs it', async () => {
    const res = await createInvite(await session('alice@example.com'), 'w1', 'admin')
    expect(res.statusCode).toBe(201)
    const { invite, token } = createdInviteSchema.parse(res.json())
    expect(invite).toMatchObject({
      workspaceId: 'w1',
      workspaceRole: 'admin',
      createdBy: 'p-alice',
    })
    const days = (Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)) / 86_400_000
    expect(days).toBeCloseTo(7)

    const row = await db.selectFrom('invite').selectAll().executeTakeFirstOrThrow()
    expect(row.token_hash).toBe(hashToken(token))
    const log = await db.selectFrom('access_log').selectAll().execute()
    expect(log).toMatchObject([
      { workspace_id: 'w1', seq: 1, actor: 'p-alice', action: 'invite.create', target: invite.id },
    ])
  })

  it('lets an admin invite members but not owners', async () => {
    const bob = await session('bob@example.com')
    expect((await createInvite(bob, 'w1', 'member')).statusCode).toBe(201)
    const owner = await createInvite(bob, 'w1', 'owner')
    expect(owner.statusCode).toBe(403)
    expect(owner.json()).toMatchObject({ error: 'forbidden' })
  })

  it('is forbidden to members', async () => {
    const res = await createInvite(await session('carol@example.com'))
    expect(res.statusCode).toBe(403)
  })

  it('is a 404 in a workspace the caller is not in, and 401 without credentials', async () => {
    expect((await createInvite(await session('alice@example.com'), 'w2')).statusCode).toBe(404)
    expect((await createInvite({}, 'w1')).statusCode).toBe(401)
  })

  it('rejects an unknown role and an expiry out of range', async () => {
    const alice = await session('alice@example.com')
    expect((await createInvite(alice, 'w1', 'superuser')).statusCode).toBe(400)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/w1/invites',
      headers: alice,
      payload: { workspaceRole: 'member', expiresInDays: 31 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /v1/auth/invites/:token', () => {
  it('creates an account, joins the workspace, signs in, and logs the join', async () => {
    const token = await inviteToken('w2', 'viewer')
    const res = await accept(token, newAccount)
    expect(res.statusCode).toBe(201)
    const { workspaceId, principalId } = acceptedInviteSchema.parse(res.json())
    expect(workspaceId).toBe('w2')

    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('email', '=', 'erin@example.com')
      .executeTakeFirstOrThrow()
    expect(account.name).toBe('Erin')
    expect(await verifyPassword(newAccount.password, account.password_hash)).toBe(true)
    const principal = await db
      .selectFrom('principal')
      .selectAll()
      .where('id', '=', principalId)
      .executeTakeFirstOrThrow()
    expect(principal).toMatchObject({
      workspace_id: 'w2',
      kind: 'user',
      workspace_role: 'viewer',
      account_id: account.id,
      name: 'Erin',
    })
    const invite = await db.selectFrom('invite').select('used_at').executeTakeFirstOrThrow()
    expect(invite.used_at).not.toBeNull()
    const log = await db
      .selectFrom('access_log')
      .selectAll()
      .where('action', '=', 'member.join')
      .execute()
    expect(log).toMatchObject([{ workspace_id: 'w2', actor: principalId, target: principalId }])

    // Signed in as the new account.
    const me = await app.inject({
      url: '/v1/me',
      headers: { cookie: cookieOf(res.headers['set-cookie']) },
    })
    expect(meSchema.parse(me.json())).toMatchObject({
      account: { email: 'erin@example.com' },
      memberships: [{ workspace: { id: 'w2' }, workspaceRole: 'viewer' }],
    })
  })

  it('adds a signed-in existing account', async () => {
    const token = await inviteToken('w2', 'member')
    const carol = await session('carol@example.com')
    const res = await accept(token, {}, carol)
    expect(res.statusCode).toBe(201)
    expect(res.headers['set-cookie']).toBeUndefined()
    const me = meSchema.parse((await app.inject({ url: '/v1/me', headers: carol })).json())
    expect(me.kind === 'person' && me.memberships.map((m) => m.workspace.id)).toEqual(['w1', 'w2'])
  })

  it('is a 404 for an unknown, used or expired invite', async () => {
    expect((await accept('x'.repeat(43), newAccount)).statusCode).toBe(404)

    const used = await inviteToken()
    expect((await accept(used, newAccount)).statusCode).toBe(201)
    const again = await accept(used, { ...newAccount, email: 'other@example.com' })
    expect(again.statusCode).toBe(404)
    expect(again.json()).toMatchObject({ error: 'not_found' })

    const expired = await inviteToken('w2')
    await db
      .updateTable('invite')
      .set({
        created_at: sql`now() - interval '2 days'`,
        expires_at: sql`now() - interval '1 day'`,
      })
      .where('token_hash', '=', hashToken(expired))
      .execute()
    expect((await accept(expired, {}, await session('carol@example.com'))).statusCode).toBe(404)
    // Nothing was created by the failed attempts.
    expect(
      await db
        .selectFrom('account')
        .select('id')
        .where('email', '=', 'other@example.com')
        .execute(),
    ).toEqual([])
  })

  it('is a 409 for an account already in the workspace, and leaves the invite unused', async () => {
    const token = await inviteToken('w1')
    const res = await accept(token, {}, await session('alice@example.com'))
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'already_member' })
    const invite = await db.selectFrom('invite').select('used_at').executeTakeFirstOrThrow()
    expect(invite.used_at).toBeNull()
  })

  it('is a 409, not a 500, when one account redeems two invites to a workspace at once', async () => {
    const first = await inviteToken('w2')
    const second = await inviteToken('w2')
    const carol = await session('carol@example.com')
    let racing: ReturnType<typeof accept> | undefined
    await db.transaction().execute(async (trx) => {
      // The first redeem holds its transaction open while the second request runs.
      await sql`SELECT * FROM redeem_invite(${hashToken(first)}, 'carol')`.execute(trx)
      racing = accept(second, {}, carol)
      await waitForLockWait()
    })
    const res = await racing
    expect(res?.statusCode).toBe(409)
    expect(res?.json()).toMatchObject({ error: 'already_member' })
    const invites = await db
      .selectFrom('invite')
      .select(['token_hash', 'used_at'])
      .where('workspace_id', '=', 'w2')
      .execute()
    const usedAt = (token: string) =>
      invites.find((i) => i.token_hash === hashToken(token))?.used_at
    expect(usedAt(first)).not.toBeNull()
    expect(usedAt(second)).toBeNull()
  })

  it('says an email is taken only to a holder of a valid invite, and changes nothing', async () => {
    const taken = { ...newAccount, email: 'dave@example.com' }
    expect((await accept('y'.repeat(43), taken)).statusCode).toBe(404)

    const token = await inviteToken('w2')
    const res = await accept(token, taken)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'email_taken' })
    const invite = await db.selectFrom('invite').select('used_at').executeTakeFirstOrThrow()
    expect(invite.used_at).toBeNull()
    expect(
      await db.selectFrom('principal').select('id').where('account_id', '=', 'dave').execute(),
    ).toEqual([])
    expect(
      await verifyPassword(
        PASSWORD,
        (
          await db
            .selectFrom('account')
            .select('password_hash')
            .where('id', '=', 'dave')
            .executeTakeFirstOrThrow()
        ).password_hash,
      ),
    ).toBe(true)
  })

  it('needs a session or new account details', async () => {
    const token = await inviteToken()
    const res = await accept(token, {})
    expect(res.statusCode).toBe(401)
    // The dev key has no account to add.
    expect((await accept(token, {}, dev)).statusCode).toBe(401)
  })

  it('rejects a short password and a malformed token', async () => {
    const token = await inviteToken()
    expect((await accept(token, { ...newAccount, password: 'short' })).statusCode).toBe(400)
    expect((await accept('bad token!', newAccount)).statusCode).toBe(400)
  })

  it('refuses cross-site acceptance', async () => {
    const token = await inviteToken()
    expect((await accept(token, newAccount, crossSite)).statusCode).toBe(403)
  })

  it('is rate-limited per client IP', async () => {
    app = build({ loginPerIp: { max: 2, windowSeconds: 60 } })
    await accept('z'.repeat(43), newAccount)
    await accept('z'.repeat(43), newAccount)
    const res = await accept('z'.repeat(43), newAccount)
    expect(res.statusCode).toBe(429)
  })
})

describe('resetPassword (pnpm account:reset-password)', () => {
  it('sets the password and ends every session of the account', async () => {
    const alice = await session('alice@example.com')
    await session('bob@example.com')
    expect(await resetPassword(db, ' Alice@Example.com', 'a brand new password')).toBe(true)

    expect((await app.inject({ url: '/v1/me', headers: alice })).statusCode).toBe(401)
    expect((await login('alice@example.com')).statusCode).toBe(401)
    expect((await login('alice@example.com', 'a brand new password')).statusCode).toBe(200)
    // Other accounts keep their sessions.
    const owners = await db
      .selectFrom('session')
      .select('account_id')
      .orderBy('account_id')
      .execute()
    expect(owners.map((s) => s.account_id)).toEqual(['alice', 'bob'])
  })

  it('returns false for an unknown email and refuses a short password', async () => {
    expect(await resetPassword(db, 'nobody@example.com', 'a brand new password')).toBe(false)
    await expect(resetPassword(db, 'alice@example.com', 'short')).rejects.toThrow(/12 to 256/)
    expect((await login('alice@example.com')).statusCode).toBe(200)
  })
})

describe('SECURITY DEFINER lookups', () => {
  it('run as their owner with a pinned search_path, and PUBLIC cannot call them', async () => {
    const { rows } = await sql<{
      proname: string
      prosecdef: boolean
      proconfig: string[]
      public_exec: boolean
    }>`
      SELECT proname, prosecdef, proconfig,
             has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc WHERE proname IN ('account_memberships', 'redeem_invite') ORDER BY proname
    `.execute(db)
    expect(rows).toEqual([
      {
        proname: 'account_memberships',
        prosecdef: true,
        proconfig: ['search_path=public, pg_temp'],
        public_exec: false,
      },
      {
        proname: 'redeem_invite',
        prosecdef: true,
        proconfig: ['search_path=public, pg_temp'],
        public_exec: false,
      },
    ])
  })
})
