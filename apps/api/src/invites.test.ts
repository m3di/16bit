import { createdInviteSchema, invitePageSchema, type CreatedInvite } from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { hashAgentSecret, newAgentSecret } from './auth/agent-key.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'

// Integration tests for listing and revoking invites (#113, D43, D48, docs/ROLES.md) against a
// real Postgres. Creating and redeeming invites is covered in auth/auth.test.ts.

let db: Kysely<Database>
/** The API's role, under row-level security (#44). `db` is the owner, for fixtures. */
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let botSecret: string
const sessions = new Map<string, { cookie: string }>()

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await seed()
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  sessions.clear()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

/**
 * w1: own (owner), adm (admin), mem (member), vw (viewer), fin (finance), and agent `bot` with
 * an editor key on hub `h`. w2: own2 (owner).
 */
async function seed(): Promise<void> {
  await db
    .insertInto('workspace')
    .values([
      { id: 'w1', name: 'Alpha' },
      { id: 'w2', name: 'Other' },
    ])
    .execute()
  const p = (
    workspace_id: string,
    id: string,
    workspace_role: 'owner' | 'admin' | 'member' | 'viewer' | 'finance',
  ) => ({ workspace_id, id, kind: 'user' as const, name: id, workspace_role })
  await db
    .insertInto('principal')
    .values([
      p('w1', 'own', 'owner'),
      p('w1', 'adm', 'admin'),
      p('w1', 'mem', 'member'),
      p('w1', 'vw', 'viewer'),
      p('w1', 'fin', 'finance'),
      p('w2', 'own2', 'owner'),
      { workspace_id: 'w1', id: 'bot', kind: 'agent', name: 'Bot', workspace_role: 'member' },
    ])
    .execute()
  await db
    .insertInto('folder')
    .values({
      workspace_id: 'w1',
      id: 'h',
      hub_id: 'h',
      parent_id: null,
      name: 'H',
      color: 'blue',
      id_prefix: 'H',
    })
    .execute()
  await db
    .insertInto('hub_grant')
    .values({
      workspace_id: 'w1',
      hub_id: 'h',
      principal_id: 'bot',
      principal_kind: 'agent',
      hub_role: 'editor',
    })
    .execute()
  botSecret = newAgentSecret()
  await db
    .insertInto('agent_key')
    .values({
      workspace_id: 'w1',
      principal_id: 'bot',
      secret_hash: hashAgentSecret(botSecret),
      created_by: 'own',
      expires_at: null,
    })
    .execute()
}

async function as(principalId: string): Promise<{ cookie: string }> {
  let session = sessions.get(principalId)
  if (!session) {
    session = await sessionCookie(db, principalId)
    sessions.set(principalId, session)
  }
  return session
}

const person = async (who: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: await as(who), payload })

async function invite(who: string, workspaceRole = 'member', workspace = 'w1') {
  const res = await person(who, 'POST', `/v1/workspaces/${workspace}/invites`, { workspaceRole })
  expect(res.statusCode).toBe(201)
  return createdInviteSchema.parse(res.json())
}

const list = (who: string, query = '', workspace = 'w1') =>
  person(who, 'GET', `/v1/workspaces/${workspace}/invites${query}`)

const revoke = (who: string, id: string, workspace = 'w1') =>
  person(who, 'POST', `/v1/workspaces/${workspace}/invites/${id}/revoke`)

/** Redeems as a new account; 201 or 404. */
const redeem = (created: CreatedInvite, email = 'new@example.com') =>
  app.inject({
    method: 'POST',
    url: `/v1/auth/invites/${created.token}`,
    payload: { name: 'New', email, password: 'a long new password' },
  })

const logOf = (action: string) =>
  db
    .selectFrom('access_log')
    .select(['actor', 'action', 'target', 'detail'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute()

describe('GET /v1/workspaces/:workspaceId/invites', () => {
  it('lists pending invites newest first, without tokens, leaving out used and expired ones', async () => {
    const a = await invite('own', 'member')
    const b = await invite('adm', 'viewer')
    const used = await invite('own', 'member')
    expect((await redeem(used)).statusCode).toBe(201)
    const expired = await invite('own', 'finance')
    await db
      .updateTable('invite')
      .set({
        created_at: sql`now() - interval '2 days'`,
        expires_at: sql`now() - interval '1 day'`,
      })
      .where('id', '=', expired.invite.id)
      .execute()

    const res = await list('own')
    expect(res.statusCode).toBe(200)
    const page = invitePageSchema.parse(res.json())
    expect(page).toEqual({ items: [b.invite, a.invite], nextCursor: null })
    expect(res.body).not.toContain(a.token)
  })

  it('pages with a cursor, also through invites created in the same instant', async () => {
    const made = [] as string[]
    for (let i = 0; i < 5; i++) made.push((await invite('own')).invite.id)
    // Two share a created_at: the ID breaks the tie, so nothing is skipped or repeated.
    await db
      .updateTable('invite')
      .set({ created_at: sql`'2026-11-01T00:00:00.123456Z'::timestamptz` })
      .where('id', 'in', made.slice(1, 3))
      .execute()

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const res = await list('adm', query)
      expect(res.statusCode).toBe(200)
      const page = invitePageSchema.parse(res.json())
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect([...seen].sort()).toEqual([...made].sort())
    expect(new Set(seen).size).toBe(5)
  })

  it('lets owners and admins list, owner-role invites included; refuses everyone else', async () => {
    const owner = await invite('own', 'owner')
    expect(invitePageSchema.parse((await list('adm')).json()).items).toEqual([owner.invite])

    for (const who of ['mem', 'vw', 'fin']) {
      const res = await list(who)
      expect(res.statusCode, who).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden' })
    }
    const bot = await app.inject({
      url: '/v1/workspaces/w1/invites',
      headers: { authorization: `Bearer ${botSecret}` },
    })
    expect(bot.statusCode).toBe(403)
  })

  it('shows only the path workspace: 404 elsewhere, 401 without credentials', async () => {
    await invite('own2', 'member', 'w2')
    expect(invitePageSchema.parse((await list('own')).json()).items).toEqual([])
    expect((await list('own', '', 'w2')).statusCode).toBe(404)
    expect((await app.inject({ url: '/v1/workspaces/w1/invites' })).statusCode).toBe(401)
  })

  it('rejects a bad limit or cursor with 400', async () => {
    expect((await list('own', '?limit=0')).statusCode).toBe(400)
    expect((await list('own', '?limit=201')).statusCode).toBe(400)
    expect((await list('own', '?cursor=not-a-cursor')).statusCode).toBe(400)
    const wrongShape = Buffer.from(JSON.stringify(['yesterday', 'x'])).toString('base64url')
    expect((await list('own', `?cursor=${wrongShape}`)).statusCode).toBe(400)
  })
})

describe('POST /v1/workspaces/:workspaceId/invites/:inviteId/revoke', () => {
  it('ends the invite, logs it, and makes redeeming it a 404', async () => {
    const created = await invite('own', 'admin')
    expect(await logOf('invite.create')).toMatchObject([
      { actor: 'own', target: created.invite.id },
    ])

    const res = await revoke('own', created.invite.id)
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(await logOf('invite.revoke')).toEqual([
      {
        actor: 'own',
        action: 'invite.revoke',
        target: created.invite.id,
        detail: { workspaceRole: 'admin' },
      },
    ])
    expect(invitePageSchema.parse((await list('own')).json()).items).toEqual([])

    const redeemed = await redeem(created)
    expect(redeemed.statusCode).toBe(404)
    expect(redeemed.json()).toMatchObject({ error: 'not_found' })
    expect(
      await db.selectFrom('account').select('id').where('email', '=', 'new@example.com').execute(),
    ).toEqual([])
  })

  it('is a 204 that changes and logs nothing for an invite that already ended', async () => {
    const created = await invite('own')
    expect((await revoke('own', created.invite.id)).statusCode).toBe(204)
    expect((await revoke('adm', created.invite.id)).statusCode).toBe(204)
    expect(await logOf('invite.revoke')).toHaveLength(1)

    const used = await invite('own')
    expect((await redeem(used, 'used@example.com')).statusCode).toBe(201)
    const before = await db
      .selectFrom('invite')
      .select(['used_at', 'expires_at'])
      .where('id', '=', used.invite.id)
      .executeTakeFirstOrThrow()
    expect((await revoke('own', used.invite.id)).statusCode).toBe(204)
    const after = await db
      .selectFrom('invite')
      .select(['used_at', 'expires_at'])
      .where('id', '=', used.invite.id)
      .executeTakeFirstOrThrow()
    expect(after).toEqual(before)
    expect(await logOf('invite.revoke')).toHaveLength(1)
  })

  it('lets an admin revoke any invite but an owner-role one (footnote ¹)', async () => {
    const byOwner = await invite('own', 'admin')
    expect((await revoke('adm', byOwner.invite.id)).statusCode).toBe(204)

    const owner = await invite('own', 'owner')
    const res = await revoke('adm', owner.invite.id)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'forbidden' })
    // Still pending and still redeemable; the refusal is not logged.
    const pending = invitePageSchema.parse((await list('own')).json()).items
    expect(pending.map((i) => i.id)).toEqual([owner.invite.id])
    expect((await logOf('invite.revoke')).map((l) => l.target)).toEqual([byOwner.invite.id])
    expect((await redeem(owner)).statusCode).toBe(201)

    // Refused even once it has ended: the answer doesn't depend on the invite's state.
    expect((await revoke('adm', owner.invite.id)).statusCode).toBe(403)
    expect((await revoke('own', owner.invite.id)).statusCode).toBe(204)
  })

  it('is forbidden to members, viewers, finance and agents, and changes nothing', async () => {
    const created = await invite('own')
    for (const who of ['mem', 'vw', 'fin']) {
      expect((await revoke(who, created.invite.id)).statusCode, who).toBe(403)
    }
    const bot = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/w1/invites/${created.invite.id}/revoke`,
      headers: { authorization: `Bearer ${botSecret}` },
    })
    expect(bot.statusCode).toBe(403)
    expect(await logOf('invite.revoke')).toEqual([])
    expect((await redeem(created)).statusCode).toBe(201)
  })

  it('is a 404 for an unknown invite or one in another workspace, 401 without credentials', async () => {
    expect((await revoke('own', 'no-such-invite')).statusCode).toBe(404)
    const elsewhere = await invite('own2', 'member', 'w2')
    expect((await revoke('own', elsewhere.invite.id)).statusCode).toBe(404)
    expect((await revoke('own', elsewhere.invite.id, 'w2')).statusCode).toBe(404)
    const anon = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/w2/invites/${elsewhere.invite.id}/revoke`,
    })
    expect(anon.statusCode).toBe(401)
    expect(await logOf('invite.revoke')).toEqual([])
    expect((await redeem(elsewhere)).statusCode).toBe(201)
  })
})
