import {
  attributeConflictErrorSchema,
  attributeSchema,
  confirmRequiredErrorSchema,
  createdAgentKeySchema,
  folderAttributesConflictErrorSchema,
  folderAttributesResultSchema,
  folderConflictErrorSchema,
  folderSchema,
  hubConflictErrorSchema,
  hubDescriptionSchema,
  hubGrantPageSchema,
  hubSchema,
} from '@16bit/core'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createDb, migrateToLatest, type Database } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'
import { sessionCookie } from './db/test-session.ts'
import { createItem } from './items.ts'
import { lockHubSchema } from './schema-lock.ts'

// Integration tests for the schema write API (#112) against a real Postgres, through the API's
// role under row-level security. Contracts: packages/core/src/hub-settings.ts. Rules:
// docs/ROLES.md, D50 to D52.

let db: Kysely<Database>
let appDb: Kysely<Database>
let drop: () => Promise<void>
let app: FastifyInstance
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

async function as(who: string): Promise<{ cookie: string }> {
  let session = sessions.get(who)
  if (!session) {
    session = await sessionCookie(db, who)
    sessions.set(who, session)
  }
  return session
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

const person = async (who: string, method: Method, path: string, payload?: object) =>
  app.inject({ method, url: `/v1/workspaces/w1${path}`, headers: await as(who), payload })

/**
 * w1. Hubs:
 *   build  folders bugs (child of build) and old (child of bugs); attributes title (text),
 *          stage (select, indexed), tags (multi-select, indexed), ref (relation in build),
 *          notes (text), docref (relation into docs, crossHub)
 *   docs   empty, targeted by build's docref
 *   tmp1   empty; grants adm hub_admin, own viewer
 *   tmp2   empty; grants adm hub_admin, ha editor
 * Principals and grants:
 *   own   owner,  hub_admin on build and docs, viewer on tmp1
 *   adm   admin,  hub_admin on tmp1 and tmp2
 *   adm2  admin,  no grants
 *   ha    member, hub_admin on build, viewer on docs, editor on tmp2
 *   ed    member, editor on build
 *   vw    viewer, hub_admin on build (acts as viewer)
 *   out   member, no grants
 * Items: i1 in build {title, stage todo, tags [a, b]}, i2 in bugs {title, stage done,
 * ref [i1]}, i3 in bugs {title, stage todo}.
 */
async function seed(): Promise<void> {
  await db.insertInto('workspace').values({ id: 'w1', name: 'Alpha' }).execute()
  const p = (id: string, workspace_role: 'owner' | 'admin' | 'member' | 'viewer') => ({
    workspace_id: 'w1',
    id,
    kind: 'user' as const,
    name: id,
    workspace_role,
  })
  await db
    .insertInto('principal')
    .values([
      p('own', 'owner'),
      p('adm', 'admin'),
      p('adm2', 'admin'),
      p('ha', 'member'),
      p('ed', 'member'),
      p('vw', 'viewer'),
      p('out', 'member'),
    ])
    .execute()
  const hub = (id: string) => ({
    workspace_id: 'w1',
    id,
    hub_id: id,
    parent_id: null,
    name: id,
    color: 'blue',
    id_prefix: 'H',
  })
  await db
    .insertInto('folder')
    .values([hub('build'), hub('docs'), hub('tmp1'), hub('tmp2')])
    .execute()
  await db
    .insertInto('folder')
    .values({ ...hub('bugs'), hub_id: 'build', parent_id: 'build' })
    .execute()
  await db
    .insertInto('folder')
    .values({ ...hub('old'), hub_id: 'build', parent_id: 'bugs' })
    .execute()
  const options = (...ids: string[]) => ({ options: ids.map((id) => ({ id, label: id })) })
  const a = (id: string, type: string, config: Record<string, unknown> = {}, indexed = false) => ({
    workspace_id: 'w1',
    id,
    hub_id: 'build',
    name: id,
    type: type as 'text',
    config,
    indexed,
  })
  await db
    .insertInto('attribute')
    .values([
      a('title', 'text'),
      a('stage', 'select', options('todo', 'doing', 'done'), true),
      a('tags', 'multi_select', options('a', 'b', 'c'), true),
      a('ref', 'relation', { targetHubId: 'build' }),
      a('notes', 'text'),
      a('docref', 'relation', { targetHubId: 'docs', crossHub: true }),
    ])
    .execute()
  const fa = (folder_id: string, attribute_id: string, position: number, required = false) => ({
    workspace_id: 'w1',
    hub_id: 'build',
    folder_id,
    attribute_id,
    position,
    required,
  })
  await db
    .insertInto('folder_attribute')
    .values([
      fa('build', 'title', 0, true),
      fa('build', 'stage', 1),
      fa('build', 'tags', 2),
      fa('bugs', 'title', 0),
      fa('bugs', 'stage', 1),
      fa('bugs', 'ref', 2),
      fa('old', 'stage', 0),
    ])
    .execute()
  const g = (hub_id: string, principal_id: string, hub_role: string) => ({
    workspace_id: 'w1',
    hub_id,
    principal_id,
    hub_role: hub_role as 'viewer',
  })
  await db
    .insertInto('hub_grant')
    .values([
      g('build', 'own', 'hub_admin'),
      g('docs', 'own', 'hub_admin'),
      g('tmp1', 'own', 'viewer'),
      g('tmp1', 'adm', 'hub_admin'),
      g('tmp2', 'adm', 'hub_admin'),
      g('build', 'ha', 'hub_admin'),
      g('docs', 'ha', 'viewer'),
      g('tmp2', 'ha', 'editor'),
      g('build', 'ed', 'editor'),
      g('build', 'vw', 'hub_admin'),
    ])
    .execute()
  await createItem(db, 'w1', 'own', {
    id: 'i1',
    folderId: 'build',
    values: { title: 'One', stage: 'todo', tags: ['a', 'b'] },
  })
  await createItem(db, 'w1', 'own', {
    id: 'i2',
    folderId: 'bugs',
    values: { title: 'Two', stage: 'done', ref: ['i1'] },
  })
  await createItem(db, 'w1', 'own', {
    id: 'i3',
    folderId: 'bugs',
    values: { title: 'Three', stage: 'todo' },
  })
}

const folderRow = (id: string) =>
  db
    .selectFrom('folder')
    .selectAll()
    .where('workspace_id', '=', 'w1')
    .where('id', '=', id)
    .executeTakeFirst()
const attributeRow = (id: string) =>
  db
    .selectFrom('attribute')
    .selectAll()
    .where('workspace_id', '=', 'w1')
    .where('id', '=', id)
    .executeTakeFirst()
const itemRow = (id: string) =>
  db
    .selectFrom('item')
    .selectAll()
    .where('workspace_id', '=', 'w1')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
const indexRows = (attributeId: string) =>
  db
    .selectFrom('item_index')
    .select(['item_id', 'ord', 'txt'])
    .where('workspace_id', '=', 'w1')
    .where('attribute_id', '=', attributeId)
    .orderBy('item_id')
    .orderBy('ord')
    .execute()
const revisions = (itemId: string) =>
  db
    .selectFrom('revision')
    .select(['version', 'patch', 'actor'])
    .where('workspace_id', '=', 'w1')
    .where('item_id', '=', itemId)
    .orderBy('seq')
    .execute()
const accessLog = () =>
  db
    .selectFrom('access_log')
    .select(['actor', 'action', 'target', 'detail'])
    .where('workspace_id', '=', 'w1')
    .orderBy('seq')
    .execute()

/** Resolves to 'pending' if `promise` has not settled within `ms`. */
const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => {
        resolve('pending')
      }, ms)
    }),
  ])

// ----------------------------------------------------------------------------------------

describe('GET /hubs/:hubId', () => {
  it('returns the title attribute and attribute versions', async () => {
    await db
      .updateTable('folder')
      .set({ title_attribute_id: 'title' })
      .where('id', '=', 'build')
      .execute()
    const res = await person('ed', 'GET', '/hubs/build')
    expect(res.statusCode).toBe(200)
    const body = hubDescriptionSchema.parse(res.json())
    expect(body.hub.titleAttributeId).toBe('title')
    expect(body.attributes.every((a) => a.version === 0)).toBe(true)
    const docs = hubDescriptionSchema.parse((await person('own', 'GET', '/hubs/docs')).json())
    expect(docs.hub.titleAttributeId).toBeNull()
  })
})

describe('PATCH /hubs/:hubId', () => {
  it('renames, recolours and sets the title attribute for a hub admin', async () => {
    const res = await person('ha', 'PATCH', '/hubs/build', {
      version: 0,
      name: ' Build ',
      color: 'teal',
      titleAttributeId: 'title',
    })
    expect(res.statusCode, res.body).toBe(200)
    const hub = hubSchema.parse(res.json())
    expect(hub).toMatchObject({ name: 'Build', color: 'teal', titleAttributeId: 'title' })
    expect(hub.version).toBe(1)

    const cleared = await person('ha', 'PATCH', '/hubs/build', {
      version: 1,
      titleAttributeId: null,
    })
    expect(hubSchema.parse(cleared.json())).toMatchObject({ titleAttributeId: null, version: 2 })
  })

  it('refuses a title attribute that is not a text attribute of the hub', async () => {
    for (const titleAttributeId of ['stage', 'missing']) {
      const res = await person('ha', 'PATCH', '/hubs/build', { version: 0, titleAttributeId })
      expect(res.statusCode, titleAttributeId).toBe(400)
      expect(res.json()).toMatchObject({ error: 'invalid_request' })
    }
    expect((await folderRow('build'))?.title_attribute_id).toBeNull()
  })

  it('is a 409 with the current hub on a stale version', async () => {
    await person('ha', 'PATCH', '/hubs/build', { version: 0, name: 'First' })
    const res = await person('ha', 'PATCH', '/hubs/build', { version: 0, name: 'Second' })
    expect(res.statusCode).toBe(409)
    const body = hubConflictErrorSchema.parse(res.json())
    expect(body.current).toMatchObject({ name: 'First', version: 1, titleAttributeId: null })
  })

  it('is 403 below hub admin, 404 without a grant or for a missing hub', async () => {
    const body = { version: 0, name: 'X' }
    expect((await person('ed', 'PATCH', '/hubs/build', body)).statusCode).toBe(403)
    expect((await person('vw', 'PATCH', '/hubs/build', body)).statusCode).toBe(403)
    expect((await person('out', 'PATCH', '/hubs/build', body)).statusCode).toBe(404)
    // Owners and admins see the hub row, but act inside it only with a grant (D45).
    expect((await person('adm2', 'PATCH', '/hubs/build', body)).statusCode).toBe(403)
    expect((await person('adm2', 'PATCH', '/hubs/nope', body)).statusCode).toBe(404)
    expect((await folderRow('build'))?.name).toBe('build')
  })

  it('refuses an agent key', async () => {
    const created = await person('ha', 'POST', '/hubs/build/agent-keys', {
      name: 'bot',
      hubRole: 'editor',
    })
    const { secret } = createdAgentKeySchema.parse(created.json())
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/workspaces/w1/hubs/build',
      headers: { authorization: `Bearer ${secret}` },
      payload: { version: 0, name: 'Bot' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('DELETE /hubs/:hubId', () => {
  it('deletes an empty hub, revoking keys and grants, and logs it (D52)', async () => {
    const created = await person('adm', 'POST', '/hubs/tmp2/agent-keys', {
      name: 'bot',
      hubRole: 'viewer',
    })
    const { key } = createdAgentKeySchema.parse(created.json())
    const before = (await accessLog()).length

    const res = await person('adm', 'DELETE', '/hubs/tmp2?version=0')
    expect(res.statusCode, res.body).toBe(204)
    expect(await folderRow('tmp2')).toBeUndefined()
    const keyRow = await db
      .selectFrom('agent_key')
      .select('revoked_at')
      .where('principal_id', '=', key.id)
      .executeTakeFirstOrThrow()
    expect(keyRow.revoked_at).not.toBeNull()
    const grants = await db
      .selectFrom('hub_grant')
      .selectAll()
      .where('hub_id', '=', 'tmp2')
      .execute()
    expect(grants).toEqual([])
    const log = (await accessLog()).slice(before)
    expect(log.map((e) => e.action)).toEqual([
      'key.revoke',
      'grant.revoke',
      'grant.revoke',
      'grant.revoke',
      'hub.delete',
    ])
    expect(log.every((e) => e.actor === 'adm')).toBe(true)
    expect((await person('adm', 'GET', '/hubs/tmp2')).statusCode).toBe(404)

    // The ID is never reused (#111): a new hub with it is a 409, not a 500.
    const again = await person('adm', 'POST', '/hubs', {
      id: 'tmp2',
      name: 'Again',
      color: 'blue',
      idPrefix: 'AG',
    })
    expect(again.statusCode, again.body).toBe(409)
    expect(again.json()).toMatchObject({ error: 'id_taken' })
  })

  it('refuses an admin when an owner holds a grant, but not the owner', async () => {
    const res = await person('adm', 'DELETE', '/hubs/tmp1?version=0')
    expect(res.statusCode).toBe(403)
    expect(await folderRow('tmp1')).toBeDefined()
    expect((await person('own', 'DELETE', '/hubs/tmp1?version=0')).statusCode).toBe(204)
  })

  it('is 409 not_empty, in_use or conflict as delete_hub says', async () => {
    const full = await person('own', 'DELETE', '/hubs/build?version=0')
    expect(full.statusCode).toBe(409)
    expect(full.json()).toMatchObject({ error: 'not_empty' })

    const targeted = await person('own', 'DELETE', '/hubs/docs?version=0')
    expect(targeted.statusCode).toBe(409)
    expect(targeted.json()).toMatchObject({ error: 'in_use' })

    await db.updateTable('folder').set({ version: 3 }).where('id', '=', 'tmp1').execute()
    const stale = await person('own', 'DELETE', '/hubs/tmp1?version=0')
    expect(stale.statusCode).toBe(409)
    const body = hubConflictErrorSchema.parse(stale.json())
    expect(body.current).toMatchObject({ id: 'tmp1', version: 3 })
    expect(await folderRow('tmp1')).toBeDefined()
  })

  it('is 403 for members and grantless admins, 404 for hidden or missing hubs', async () => {
    expect((await person('ha', 'DELETE', '/hubs/tmp2?version=0')).statusCode).toBe(403)
    expect((await person('adm2', 'DELETE', '/hubs/tmp2?version=0')).statusCode).toBe(403)
    expect((await person('out', 'DELETE', '/hubs/tmp2?version=0')).statusCode).toBe(404)
    expect((await person('own', 'DELETE', '/hubs/nope?version=0')).statusCode).toBe(404)
    expect((await person('own', 'DELETE', '/hubs/tmp2')).statusCode).toBe(400)
    expect(await folderRow('tmp2')).toBeDefined()
  })
})

describe('GET /hubs/:hubId/grants', () => {
  it('pages the grants by name for a hub admin', async () => {
    const first = await person('ha', 'GET', '/hubs/build/grants?limit=2')
    expect(first.statusCode).toBe(200)
    const page1 = hubGrantPageSchema.parse(first.json())
    expect(page1.items.map((g) => g.principalId)).toEqual(['ed', 'ha'])
    expect(page1.items[0]).toEqual({
      principalId: 'ed',
      kind: 'user',
      name: 'ed',
      workspaceRole: 'member',
      hubRole: 'editor',
    })
    const cursor = page1.nextCursor ?? ''
    const page2 = hubGrantPageSchema.parse(
      (await person('ha', 'GET', `/hubs/build/grants?limit=2&cursor=${cursor}`)).json(),
    )
    expect(page2.items.map((g) => g.principalId)).toEqual(['own', 'vw'])
    expect(page2.nextCursor).toBeNull()
  })

  it('lists for owners and admins without a grant, not for others', async () => {
    expect((await person('adm2', 'GET', '/hubs/build/grants')).statusCode).toBe(200)
    expect((await person('ed', 'GET', '/hubs/build/grants')).statusCode).toBe(403)
    expect((await person('vw', 'GET', '/hubs/build/grants')).statusCode).toBe(403)
    expect((await person('out', 'GET', '/hubs/build/grants')).statusCode).toBe(404)
    expect((await person('adm2', 'GET', '/hubs/nope/grants')).statusCode).toBe(404)
  })
})

describe('folders', () => {
  it('creates a folder under the hub or a folder, with the hub prefix', async () => {
    const res = await person('ha', 'POST', '/hubs/build/folders', {
      id: 'new',
      parentId: 'bugs',
      name: 'New',
      color: 'green',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(folderSchema.parse(res.json())).toMatchObject({
      id: 'new',
      hubId: 'build',
      parentId: 'bugs',
      idPrefix: 'H',
      itemCount: 0,
      version: 0,
    })
    const taken = await person('ha', 'POST', '/hubs/build/folders', {
      id: 'new',
      parentId: 'build',
      name: 'Again',
      color: 'green',
    })
    expect(taken.statusCode).toBe(409)
    expect(taken.json()).toMatchObject({ error: 'id_taken' })
  })

  it('refuses a parent outside the hub, and lower roles', async () => {
    const body = { parentId: 'docs', name: 'X', color: 'blue' }
    expect((await person('ha', 'POST', '/hubs/build/folders', body)).statusCode).toBe(400)
    const ok = { ...body, parentId: 'build' }
    expect((await person('ed', 'POST', '/hubs/build/folders', ok)).statusCode).toBe(403)
    expect((await person('out', 'POST', '/hubs/build/folders', ok)).statusCode).toBe(404)
    expect((await person('ha', 'POST', '/hubs/nope/folders', ok)).statusCode).toBe(404)
  })

  it('renames and moves a folder with a version check', async () => {
    const res = await person('ha', 'PATCH', '/folders/old', {
      version: 0,
      name: 'Archive',
      parentId: 'build',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(folderSchema.parse(res.json())).toMatchObject({
      name: 'Archive',
      parentId: 'build',
      version: 1,
    })
    const stale = await person('ha', 'PATCH', '/folders/old', { version: 0, name: 'Again' })
    expect(stale.statusCode).toBe(409)
    expect(folderConflictErrorSchema.parse(stale.json()).current.name).toBe('Archive')
  })

  it('refuses moving a folder under itself, a descendant, or another hub (400)', async () => {
    for (const parentId of ['bugs', 'old', 'docs', 'nope']) {
      const res = await person('ha', 'PATCH', '/folders/bugs', { version: 0, parentId })
      expect(res.statusCode, parentId).toBe(400)
    }
    expect((await folderRow('bugs'))?.parent_id).toBe('build')
  })

  it('sends hubs to the hub routes and refuses lower roles', async () => {
    expect(
      (await person('ha', 'PATCH', '/folders/build', { version: 0, name: 'X' })).statusCode,
    ).toBe(400)
    expect((await person('ha', 'DELETE', '/folders/build?version=0')).statusCode).toBe(400)
    expect(
      (await person('ed', 'PATCH', '/folders/bugs', { version: 0, name: 'X' })).statusCode,
    ).toBe(403)
    expect(
      (await person('out', 'PATCH', '/folders/bugs', { version: 0, name: 'X' })).statusCode,
    ).toBe(404)
    expect((await person('ed', 'DELETE', '/folders/old?version=0')).statusCode).toBe(403)
    expect((await person('out', 'DELETE', '/folders/old?version=0')).statusCode).toBe(404)
  })

  it('deletes an empty folder with its attached attributes, and refuses a non-empty one', async () => {
    const withItems = await person('ha', 'DELETE', '/folders/bugs?version=0')
    expect(withItems.statusCode).toBe(409)
    expect(withItems.json()).toMatchObject({ error: 'not_empty' })

    const stale = await person('ha', 'DELETE', '/folders/old?version=5')
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'conflict' })

    const res = await person('ha', 'DELETE', '/folders/old?version=0')
    expect(res.statusCode, res.body).toBe(204)
    expect(await folderRow('old')).toBeUndefined()
    const attached = await db
      .selectFrom('folder_attribute')
      .selectAll()
      .where('folder_id', '=', 'old')
      .execute()
    expect(attached).toEqual([])
  })

  it('refuses deleting a folder that holds a subfolder', async () => {
    await db.deleteFrom('item').where('folder_id', '=', 'bugs').execute()
    const res = await person('ha', 'DELETE', '/folders/bugs?version=0')
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'not_empty' })
  })
})

describe('PUT /folders/:folderId/attributes', () => {
  it('attaches, detaches, reorders and requires, counting empty items (D51)', async () => {
    const res = await person('ha', 'PUT', '/folders/bugs/attributes', {
      version: 0,
      attributes: [
        { attributeId: 'notes', required: true },
        { attributeId: 'title', required: true },
        { attributeId: 'stage' },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = folderAttributesResultSchema.parse(res.json())
    expect(body.folder.version).toBe(1)
    expect(body.attributes.map((a) => [a.attributeId, a.position, a.required])).toEqual([
      ['notes', 0, true],
      ['title', 1, true],
      ['stage', 2, false],
    ])
    expect(body.requiredEmpty).toEqual([
      { attributeId: 'notes', items: 2 },
      { attributeId: 'title', items: 0 },
    ])
    // Detaching keeps values.
    expect((await itemRow('i2')).values).toMatchObject({ ref: ['i1'] })

    // Items that leave a newly required attribute empty stay valid for edits that don't touch it.
    const edit = await person('ed', 'PATCH', '/items/i3', { version: 1, values: { stage: 'done' } })
    expect(edit.statusCode, edit.body).toBe(200)
  })

  it('previews with dryRun, writing nothing', async () => {
    const res = await person('ha', 'PUT', '/folders/bugs/attributes', {
      version: 0,
      dryRun: true,
      attributes: [{ attributeId: 'notes', required: true }],
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = folderAttributesResultSchema.parse(res.json())
    expect(body.folder.version).toBe(0)
    expect(body.attributes).toHaveLength(1)
    expect(body.requiredEmpty).toEqual([{ attributeId: 'notes', items: 2 }])
    expect((await folderRow('bugs'))?.version).toBe(0)
    const rows = await db
      .selectFrom('folder_attribute')
      .select('attribute_id')
      .where('folder_id', '=', 'bugs')
      .execute()
    expect(rows).toHaveLength(3)
  })

  it('is a 409 with the folder and its attributes on a stale version', async () => {
    const res = await person('ha', 'PUT', '/folders/bugs/attributes', {
      version: 4,
      attributes: [],
    })
    expect(res.statusCode).toBe(409)
    const body = folderAttributesConflictErrorSchema.parse(res.json())
    expect(body.current.attributes.map((a) => a.attributeId)).toEqual(['title', 'stage', 'ref'])
  })

  it('refuses attributes of another hub and lower roles', async () => {
    const other = await person('own', 'POST', '/hubs/docs/attributes', {
      id: 'dtitle',
      name: 'Title',
      type: 'text',
      config: {},
    })
    expect(other.statusCode, other.body).toBe(201)
    const body = { version: 0, attributes: [{ attributeId: 'dtitle' }] }
    expect((await person('ha', 'PUT', '/folders/bugs/attributes', body)).statusCode).toBe(400)
    const ok = { version: 0, attributes: [] }
    expect((await person('ed', 'PUT', '/folders/bugs/attributes', ok)).statusCode).toBe(403)
    expect((await person('out', 'PUT', '/folders/bugs/attributes', ok)).statusCode).toBe(404)
    expect((await folderRow('bugs'))?.version).toBe(0)
  })
})

describe('creating attributes', () => {
  it('creates an attribute at version 0', async () => {
    const res = await person('ha', 'POST', '/hubs/build/attributes', {
      id: 'due',
      name: 'Due',
      type: 'date',
      config: {},
      indexed: true,
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(attributeSchema.parse(res.json())).toMatchObject({
      id: 'due',
      hubId: 'build',
      version: 0,
      indexed: true,
    })
    const taken = await person('ha', 'POST', '/hubs/build/attributes', {
      id: 'due',
      name: 'Due',
      type: 'date',
      config: {},
    })
    expect(taken.statusCode).toBe(409)
  })

  it('needs viewer access on the target hub of a cross-hub relation (D11)', async () => {
    const rel = (id: string, targetHubId: string, crossHub = true) => ({
      id,
      name: id,
      type: 'relation',
      config: { targetHubId, crossHub },
    })
    // ha is a viewer on docs.
    expect(
      (await person('ha', 'POST', '/hubs/build/attributes', rel('r1', 'docs'))).statusCode,
    ).toBe(201)
    // own holds no grant on tmp2; tmp2 is hidden inside even from an owner (D45).
    expect(
      (await person('own', 'POST', '/hubs/build/attributes', rel('r2', 'tmp2'))).statusCode,
    ).toBe(404)
    // A missing hub answers the same.
    expect(
      (await person('ha', 'POST', '/hubs/build/attributes', rel('r3', 'nope'))).statusCode,
    ).toBe(404)
    // Without crossHub the target must be the attribute's own hub.
    expect(
      (await person('ha', 'POST', '/hubs/build/attributes', rel('r4', 'docs', false))).statusCode,
    ).toBe(400)
    expect(await attributeRow('r2')).toBeUndefined()
  })

  it('refuses lower roles', async () => {
    const body = { name: 'X', type: 'text', config: {} }
    expect((await person('ed', 'POST', '/hubs/build/attributes', body)).statusCode).toBe(403)
    expect((await person('vw', 'POST', '/hubs/build/attributes', body)).statusCode).toBe(403)
    expect((await person('out', 'POST', '/hubs/build/attributes', body)).statusCode).toBe(404)
  })
})

describe('updating attributes', () => {
  it('renames with a version check, and a conflict carries the current version', async () => {
    const res = await person('ha', 'PATCH', '/attributes/notes', { version: 0, name: 'Notes' })
    expect(res.statusCode, res.body).toBe(200)
    expect(attributeSchema.parse(res.json())).toMatchObject({ name: 'Notes', version: 1 })
    const stale = await person('ha', 'PATCH', '/attributes/notes', { version: 0, name: 'N' })
    expect(stale.statusCode).toBe(409)
    const { current } = attributeConflictErrorSchema.parse(stale.json())
    expect(current).toMatchObject({ name: 'Notes', version: 1 })
    // Retrying with current.version works.
    const retry = await person('ha', 'PATCH', '/attributes/notes', {
      version: current.version,
      name: 'N',
    })
    expect(retry.statusCode).toBe(200)
  })

  it('refuses type, config, options on a type without them, and lower roles', async () => {
    expect(
      (await person('ha', 'PATCH', '/attributes/notes', { version: 0, type: 'number' })).statusCode,
    ).toBe(400)
    expect(
      (await person('ha', 'PATCH', '/attributes/notes', { version: 0, options: [] })).statusCode,
    ).toBe(400)
    expect(
      (await person('ed', 'PATCH', '/attributes/notes', { version: 0, name: 'X' })).statusCode,
    ).toBe(403)
    expect(
      (await person('out', 'PATCH', '/attributes/notes', { version: 0, name: 'X' })).statusCode,
    ).toBe(404)
    expect(
      (await person('ha', 'PATCH', '/attributes/nope', { version: 0, name: 'X' })).statusCode,
    ).toBe(404)
  })

  it('removes a select option only with the right count, stripping values with revisions', async () => {
    const options = [
      { id: 'doing', label: 'Doing' },
      { id: 'done', label: 'Done' },
    ]
    const missing = await person('ha', 'PATCH', '/attributes/stage', { version: 0, options })
    expect(missing.statusCode).toBe(409)
    expect(confirmRequiredErrorSchema.parse(missing.json()).affected).toBe(2)

    const wrong = await person('ha', 'PATCH', '/attributes/stage', {
      version: 0,
      options,
      confirm: 1,
    })
    expect(wrong.statusCode).toBe(409)
    expect(wrong.json()).toMatchObject({ error: 'confirm_required', affected: 2 })
    expect((await itemRow('i1')).values).toMatchObject({ stage: 'todo' })

    const res = await person('ha', 'PATCH', '/attributes/stage', {
      version: 0,
      options,
      confirm: 2,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(attributeSchema.parse(res.json()).version).toBe(1)
    for (const id of ['i1', 'i3']) {
      const item = await itemRow(id)
      expect(item.values, id).not.toHaveProperty('stage')
      expect(item.version, id).toBe(2)
      expect(item.updated_by).toBe('ha')
      expect((await revisions(id)).at(-1)).toEqual({
        version: 2,
        patch: { op: 'update', values: { stage: null } },
        actor: 'ha',
      })
    }
    expect((await itemRow('i2')).version).toBe(1)
    expect(await indexRows('stage')).toEqual([{ item_id: 'i2', ord: 0, txt: 'done' }])
    // The two revisions take the next two sequence numbers, in item ID order.
    const log = await db
      .selectFrom('revision')
      .select(['seq', 'item_id'])
      .where('workspace_id', '=', 'w1')
      .orderBy('seq')
      .execute()
    const workspace = await db
      .selectFrom('workspace')
      .select('next_revision_seq')
      .where('id', '=', 'w1')
      .executeTakeFirstOrThrow()
    const last = log.slice(-2)
    expect(last.map((r) => r.item_id)).toEqual(['i1', 'i3'])
    expect((last[1]?.seq ?? 0) - (last[0]?.seq ?? 0)).toBe(1)
    expect(workspace.next_revision_seq).toBe((last[1]?.seq ?? 0) + 1)

    // A value with the removed option is refused from now on.
    const edit = await person('ed', 'PATCH', '/items/i3', { version: 2, values: { stage: 'todo' } })
    expect(edit.statusCode).toBe(422)
  })

  it('strips a removed option from multi-select lists and reindexes them', async () => {
    const res = await person('ha', 'PATCH', '/attributes/tags', {
      version: 0,
      options: [
        { id: 'b', label: 'b' },
        { id: 'c', label: 'c' },
      ],
      confirm: 1,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((await itemRow('i1')).values).toMatchObject({ tags: ['b'] })
    expect((await indexRows('tags')).map((r) => [r.item_id, r.ord])).toEqual([['i1', 0]])
    expect((await revisions('i1')).at(-1)?.patch).toEqual({
      op: 'update',
      values: { tags: ['b'] },
    })
  })

  it('needs no confirm for an option no item holds', async () => {
    const res = await person('ha', 'PATCH', '/attributes/tags', {
      version: 0,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((await itemRow('i1')).version).toBe(1)
  })

  it('takes no exclusive lock when no option is removed', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const writer = db.transaction().execute(async (trx) => {
      await lockHubSchema(trx, 'w1', 'build', 'shared')
      locked()
      await held
    })
    await isLocked
    const res = await person('ha', 'PATCH', '/attributes/tags', {
      version: 0,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    release()
    await writer
  })

  it('waits for item writes in flight before stripping values', async () => {
    // An item write holds the hub's schema lock shared while it validates and writes.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const writer = db.transaction().execute(async (trx) => {
      await lockHubSchema(trx, 'w1', 'build', 'shared')
      locked()
      await held
    })
    await isLocked
    const removal = person('ha', 'PATCH', '/attributes/tags', {
      version: 0,
      options: [{ id: 'b', label: 'b' }],
      confirm: 1,
    })
    expect(await settledWithin(removal, 300)).toBe('pending')
    release()
    await writer
    expect((await removal).statusCode).toBe(200)
  })
})

describe('item writes and the hub schema lock', () => {
  /**
   * Holds the hub's schema lock exclusive, as an option removal does, until `commit()`; then
   * removes the `doing` option from `stage` in the same transaction and commits.
   */
  async function removalInFlight() {
    let commit!: () => void
    const go = new Promise<void>((resolve) => (commit = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const done = db.transaction().execute(async (trx) => {
      await lockHubSchema(trx, 'w1', 'build', 'exclusive')
      locked()
      await go
      await trx
        .updateTable('attribute')
        .set({
          config: JSON.stringify({
            options: [
              { id: 'todo', label: 'todo' },
              { id: 'done', label: 'done' },
            ],
          }),
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', 'w1')
        .where('id', '=', 'stage')
        .execute()
    })
    await isLocked
    return { commit, done }
  }

  // Each fails if the write stops taking the lock (it answers 200 at once) or takes it after
  // reading the folder's attributes (it waits, then answers 200 with the old options).
  it('a patch waits, then validates against the options as they are after the removal', async () => {
    const removal = await removalInFlight()
    const patch = person('ed', 'PATCH', '/items/i2', { version: 1, values: { stage: 'doing' } })
    expect(await settledWithin(patch, 300)).toBe('pending')
    removal.commit()
    await removal.done
    const res = await patch
    expect(res.statusCode, res.body).toBe(422)
    const i2 = await itemRow('i2')
    expect(i2.values).toMatchObject({ stage: 'done' })
    expect(i2.version).toBe(1)
  })

  it('a create waits, then validates against the options as they are after the removal', async () => {
    const removal = await removalInFlight()
    const create = person('ed', 'POST', '/items', {
      id: 'i8',
      folderId: 'bugs',
      values: { title: 'Eight', stage: 'doing' },
    })
    expect(await settledWithin(create, 300)).toBe('pending')
    removal.commit()
    await removal.done
    const res = await create
    expect(res.statusCode, res.body).toBe(422)
    const created = await db.selectFrom('item').select('id').where('id', '=', 'i8').execute()
    expect(created).toEqual([])
  })
})

describe('deleting attributes', () => {
  it('strips a relation, drops its links, detaches it and bumps folder versions', async () => {
    const missing = await person('ha', 'DELETE', '/attributes/ref?version=0')
    expect(missing.statusCode).toBe(409)
    expect(missing.json()).toMatchObject({ error: 'confirm_required', affected: 1 })

    const res = await person('ha', 'DELETE', '/attributes/ref?version=0&confirm=1')
    expect(res.statusCode, res.body).toBe(204)
    expect(await attributeRow('ref')).toBeUndefined()
    const i2 = await itemRow('i2')
    expect(i2.values).not.toHaveProperty('ref')
    expect(i2.version).toBe(2)
    expect((await revisions('i2')).at(-1)?.patch).toEqual({ op: 'update', values: { ref: null } })
    const links = await db.selectFrom('link').selectAll().where('workspace_id', '=', 'w1').execute()
    expect(links).toEqual([])
    expect((await folderRow('bugs'))?.version).toBe(1)
    expect((await folderRow('build'))?.version).toBe(0)
  })

  it('clears the hub title when its attribute goes (D50), and drops index rows', async () => {
    await person('ha', 'PATCH', '/hubs/build', { version: 0, titleAttributeId: 'title' })
    const res = await person('ha', 'DELETE', '/attributes/title?version=0&confirm=3')
    expect(res.statusCode, res.body).toBe(204)
    const hub = await folderRow('build')
    expect(hub?.title_attribute_id).toBeNull()
    expect(hub?.version).toBe(2)
    expect((await folderRow('bugs'))?.version).toBe(1)
    const stage = await person('ha', 'DELETE', '/attributes/stage?version=0&confirm=3')
    expect(stage.statusCode).toBe(204)
    expect(await indexRows('stage')).toEqual([])
  })

  it('needs no confirm when no item holds a value, and checks the version', async () => {
    expect((await person('ha', 'DELETE', '/attributes/notes?version=3')).statusCode).toBe(409)
    expect((await person('ha', 'DELETE', '/attributes/notes?version=0')).statusCode).toBe(204)
  })

  it('refuses lower roles', async () => {
    expect((await person('ed', 'DELETE', '/attributes/notes?version=0')).statusCode).toBe(403)
    expect((await person('out', 'DELETE', '/attributes/notes?version=0')).statusCode).toBe(404)
    expect(await attributeRow('notes')).toBeDefined()
  })
})

describe('lock order', () => {
  it('a folder delete against an item delete in flight is 409 not_empty, no deadlock', async () => {
    await person('ha', 'POST', '/hubs/build/folders', {
      id: 'tiny',
      parentId: 'build',
      name: 'Tiny',
      color: 'blue',
    })
    await createItem(db, 'w1', 'own', { id: 'i9', folderId: 'tiny', values: {} })

    // The item delete as items.ts orders it: the item row first, then the hub and folder rows.
    let next!: () => void
    const go = new Promise<void>((resolve) => (next = resolve))
    let deleted!: () => void
    const isDeleted = new Promise<void>((resolve) => (deleted = resolve))
    const itemDelete = db.transaction().execute(async (trx) => {
      await trx.deleteFrom('item').where('workspace_id', '=', 'w1').where('id', '=', 'i9').execute()
      deleted()
      await go
      for (const id of ['build', 'tiny']) {
        await trx
          .updateTable('folder')
          .set({ item_count: sql`item_count - 1` })
          .where('workspace_id', '=', 'w1')
          .where('id', '=', id)
          .execute()
      }
    })
    await isDeleted
    const folderDelete = await person('ha', 'DELETE', '/folders/tiny?version=0')
    expect(folderDelete.statusCode).toBe(409)
    expect(folderDelete.json()).toMatchObject({ error: 'not_empty' })
    next()
    await itemDelete
    expect(await folderRow('tiny')).toMatchObject({ item_count: 0 })
  })

  it('a folder delete waits for an item delete holding the hub row, then succeeds', async () => {
    await person('ha', 'POST', '/hubs/build/folders', {
      id: 'tiny',
      parentId: 'build',
      name: 'Tiny',
      color: 'blue',
    })
    await createItem(db, 'w1', 'own', { id: 'i9', folderId: 'tiny', values: {} })
    let next!: () => void
    const go = new Promise<void>((resolve) => (next = resolve))
    let holding!: () => void
    const isHolding = new Promise<void>((resolve) => (holding = resolve))
    const itemDelete = db.transaction().execute(async (trx) => {
      await trx.deleteFrom('item').where('workspace_id', '=', 'w1').where('id', '=', 'i9').execute()
      await trx
        .updateTable('folder')
        .set({ item_count: sql`item_count - 1` })
        .where('workspace_id', '=', 'w1')
        .where('id', '=', 'build')
        .execute()
      holding()
      await go
      await trx
        .updateTable('folder')
        .set({ item_count: sql`item_count - 1` })
        .where('workspace_id', '=', 'w1')
        .where('id', '=', 'tiny')
        .execute()
    })
    await isHolding
    const folderDelete = person('ha', 'DELETE', '/folders/tiny?version=0')
    expect(await settledWithin(folderDelete, 300)).toBe('pending')
    next()
    await itemDelete
    expect((await folderDelete).statusCode).toBe(204)
  })

  it('an item create waiting on a folder delete gets 404, not a 500', async () => {
    await person('ha', 'POST', '/hubs/build/folders', {
      id: 'tiny',
      parentId: 'build',
      name: 'Tiny',
      color: 'blue',
    })
    let next!: () => void
    const go = new Promise<void>((resolve) => (next = resolve))
    let holding!: () => void
    const isHolding = new Promise<void>((resolve) => (holding = resolve))
    // Holds the hub row like a folder delete does, then deletes the folder.
    const folderDelete = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('folder')
        .select('id')
        .where('workspace_id', '=', 'w1')
        .where('id', '=', 'build')
        .forNoKeyUpdate()
        .execute()
      holding()
      await go
      await trx
        .deleteFrom('folder')
        .where('workspace_id', '=', 'w1')
        .where('id', '=', 'tiny')
        .execute()
    })
    await isHolding
    const create = person('ed', 'POST', '/items', { folderId: 'tiny', values: {} })
    expect(await settledWithin(create, 300)).toBe('pending')
    next()
    await folderDelete
    expect((await create).statusCode).toBe(404)
  })
})
