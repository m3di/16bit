import { attributeSchema, createdInviteSchema } from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'

// #205 puts freshness (D69) and invites by external login (D72) in the contracts. Until their
// issues serve them, the API refuses what it can't honour, never ignores it: `is_stale` until
// #208, `externalLogin` and password-less acceptance until #213. `freshFor` itself is only
// attribute config, so it is stored and returned from now on. Each issue flips its part here.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
let owner: { cookie: string }

beforeEach(async () => {
  const test = await createTestDatabase()
  drop = test.drop
  db = createDb(test.url)
  appDb = createDb(test.appUrl)
  await migrateToLatest(db)
  await db.insertInto('workspace').values({ id: 'w1', name: 'Alpha' }).execute()
  await db
    .insertInto('principal')
    .values({ workspace_id: 'w1', id: 'own', kind: 'user', name: 'Own', workspace_role: 'owner' })
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
      principal_id: 'own',
      principal_kind: 'user',
      hub_role: 'hub_admin',
    })
    .execute()
  owner = await sessionCookie(db, 'own')
  app = buildApp({ db: appDb })
})

afterEach(async () => {
  await app.close()
  await appDb.destroy()
  await db.destroy()
  await drop()
})

const send = (method: 'POST' | 'PATCH' | 'PUT', url: string, payload: object, signedIn = true) =>
  app.inject({ method, url, payload, ...(signedIn ? { headers: owner } : {}) })

describe('freshFor and is_stale (D69)', () => {
  async function dateAttribute(freshFor?: string) {
    const res = await send('POST', '/v1/workspaces/w1/hubs/h/attributes', {
      id: 'due',
      name: 'Due',
      type: 'date',
      indexed: true,
      config: { includeTime: true, ...(freshFor ? { freshFor } : {}) },
    })
    expect(res.statusCode).toBe(201)
    const attached = await send('PUT', '/v1/workspaces/w1/folders/h/attributes', {
      version: 0,
      attributes: [{ attributeId: 'due' }],
    })
    expect(attached.statusCode).toBe(200)
    return attributeSchema.parse(res.json())
  }

  it('stores freshFor on a date attribute, and a patch changes and clears it', async () => {
    expect((await dateAttribute('PT2H')).config).toEqual({ includeTime: true, freshFor: 'PT2H' })
    const changed = await send('PATCH', '/v1/workspaces/w1/attributes/due', {
      version: 0,
      freshFor: 'P1D',
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ version: 1, config: { freshFor: 'P1D' } })
    const cleared = await send('PATCH', '/v1/workspaces/w1/attributes/due', {
      version: 1,
      freshFor: null,
    })
    expect(cleared.json()).toMatchObject({ version: 2, config: { includeTime: true } })
    expect(cleared.json<{ config: object }>().config).not.toHaveProperty('freshFor')
  })

  it('refuses a freshFor out of range, or on another type', async () => {
    await dateAttribute()
    const tooShort = await send('PATCH', '/v1/workspaces/w1/attributes/due', {
      version: 0,
      freshFor: 'PT30S',
    })
    expect(tooShort.statusCode).toBe(400)
    const text = await send('POST', '/v1/workspaces/w1/hubs/h/attributes', {
      name: 'Title',
      type: 'text',
      config: { freshFor: 'PT2H' },
    })
    expect(text.statusCode).toBe(400)
  })

  it('refuses is_stale with 400 until #208 serves it, and names a missing freshFor', async () => {
    await dateAttribute('PT2H')
    const query = { from: 'h', where: { attribute: 'due', op: 'is_stale' }, limit: 10 }
    const served = await send('POST', '/v1/workspaces/w1/query', query)
    expect(served.statusCode).toBe(400)
    expect(served.json()).toMatchObject({
      error: 'invalid_request',
      message: 'is_stale: not supported yet',
    })
    const aggregate = await send('POST', '/v1/workspaces/w1/aggregate', {
      from: 'h',
      where: query.where,
      measures: [{ fn: 'count' }],
    })
    expect(aggregate.statusCode).toBe(400)

    await send('PATCH', '/v1/workspaces/w1/attributes/due', { version: 0, freshFor: null })
    const unfresh = await send('POST', '/v1/workspaces/w1/query', query)
    expect(unfresh.statusCode).toBe(400)
    expect(unfresh.json<{ message: string }>().message).toMatch(
      /needs a freshFor on date attribute "due"/,
    )
  })
})

describe('invites by external login (D72)', () => {
  it('refuses externalLogin on a new invite until #213, and writes nothing', async () => {
    const res = await send('POST', '/v1/workspaces/w1/invites', {
      workspaceRole: 'member',
      externalLogin: 'mina',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: 'invalid_request',
      message: 'externalLogin: not supported yet',
    })
    expect(await db.selectFrom('invite').select('id').execute()).toEqual([])
    expect(await db.selectFrom('access_log').select('seq').execute()).toEqual([])
  })

  it('refuses accepting without a password until #213, and leaves the invite unused', async () => {
    const created = await send('POST', '/v1/workspaces/w1/invites', { workspaceRole: 'member' })
    const { token, invite } = createdInviteSchema.parse(created.json())
    expect(invite).not.toHaveProperty('externalLogin')
    const res = await send(
      'POST',
      `/v1/auth/invites/${token}`,
      { name: 'Mina', email: 'mina@example.com' },
      false,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
    const row = await db.selectFrom('invite').select('used_at').executeTakeFirstOrThrow()
    expect(row.used_at).toBeNull()
    expect(
      await db.selectFrom('account').select('id').where('email', '=', 'mina@example.com').execute(),
    ).toEqual([])
  })

  it('answers a password sign-in to an account without a password as a wrong password', async () => {
    await db
      .insertInto('account')
      .values({
        id: 'mina',
        email: 'mina@example.com',
        password_hash: null,
        name: 'Mina',
        external_login: 'mina',
      })
      .execute()
    const login = (email: string) =>
      send('POST', '/v1/auth/login', { email, password: 'a long password' }, false)
    const none = await login('mina@example.com')
    const unknown = await login('nobody@example.com')
    expect(none.statusCode).toBe(401)
    expect(none.json()).toEqual(unknown.json())
  })
})
