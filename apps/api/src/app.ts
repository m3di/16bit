import {
  createAgentKeySchema,
  createItemSchema,
  deleteItemQuerySchema,
  idSchema,
  itemQuerySchema,
  pageQuerySchema,
  patchItemSchema,
  type Folder,
  type HubDescription,
  type Page,
  type Subject,
  type Workspace,
} from '@16bit/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { createAgentKey, listAgentKeys, revokeAgentKey } from './agent-keys.ts'
import { agentHubCheck, authenticator, workspaceActor, type Identity } from './auth.ts'
import type { Database } from './db/database.ts'
import { decodeCursor, encodeCursor, HttpError, notFound, parse } from './http.ts'
import { createItem, deleteItem, getItem, patchItem, queryItems } from './items.ts'
import { toAttribute, toFolder, toFolderAttribute, toWorkspace } from './mappers.ts'
import { isAppRoute, registerWeb, sendAppShell } from './web.ts'

export interface AppOptions {
  db: Kysely<Database>
  /** The M0 development key, sent as `Authorization: Bearer <key>`. */
  devApiKey: string
  /** The principal the development key acts as. It must exist in a workspace to see it. */
  devPrincipalId: string
  /** Cap on folders and on attributes in a hub description. Folder attributes get 10 times it. */
  maxHubEntries?: number
  /** Directory of the built web app. When set, the API also serves the dashboard (D34). */
  webRoot?: string
  /**
   * Local only. A request with no Authorization header acts as the development principal,
   * as the Vite dev proxy does in `pnpm dev`. Lets the browser use the dashboard the image
   * serves without the key reaching the bundle. Removed when real auth lands in M1.
   */
  anonymousAsDevPrincipal?: boolean
}

/** Default cap on folders and attributes returned by a hub description. */
export const MAX_HUB_ENTRIES = 1000

const nameCursorSchema = z.tuple([z.string(), z.string()])
const workspaceParams = z.object({ workspaceId: idSchema })
const hubParams = z.object({ workspaceId: idSchema, hubId: idSchema })
const itemParams = z.object({ workspaceId: idSchema, itemId: idSchema })
const keyParams = z.object({ workspaceId: idSchema, keyId: idSchema })

declare module 'fastify' {
  interface FastifyRequest {
    /** Who sent the request. Set on every /v1 route. */
    identity: Identity
    /** The caller as a `can()` subject in the path's workspace. Set on workspace routes. */
    principal: Subject
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options
  const maxHubEntries = options.maxHubEntries ?? MAX_HUB_ENTRIES
  const faCap = maxHubEntries * 10
  const app = Fastify({ logger: false })
  const authenticate = authenticator(db, options)

  app.decorateRequest('identity', null as never)
  app.decorateRequest('principal', null as unknown as Subject)

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send(error.body())
    // Fastify's own client errors keep their status: 400 malformed JSON, 413 body too large,
    // 415 unsupported content type, and so on.
    const status = (error as { statusCode?: number }).statusCode
    if (status !== undefined && status >= 400 && status < 500) {
      const message = (error as Error).message
      return reply.status(status).send({ error: 'invalid_request', message })
    }
    console.error(error)
    return reply.status(500).send({ error: 'internal', message: 'Internal error' })
  })
  const webRoot = options.webRoot
  if (webRoot) registerWeb(app, webRoot)

  app.setNotFoundHandler((request, reply) => {
    if (webRoot && isAppRoute(request)) return sendAppShell(reply)
    return reply.status(404).send({ error: 'not_found', message: 'Route not found' })
  })

  app.get('/health', async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(db)
      return { status: 'ok' }
    } catch {
      return reply.status(503).send({ status: 'unavailable' })
    }
  })

  void app.register(
    (v1, _opts, done) => {
      v1.addHook('onRequest', async (request) => {
        request.identity = await authenticate(request.headers.authorization)
      })

      v1.get('/workspaces', async (request): Promise<Page<Workspace>> => {
        const { limit, cursor } = parse(pageQuerySchema, request.query)
        let q = db
          .selectFrom('workspace as w')
          .innerJoin('principal as p', 'p.workspace_id', 'w.id')
          .selectAll('w')
          .where('p.id', '=', request.identity.principalId)
        if (request.identity.kind === 'agent')
          q = q.where('w.id', '=', request.identity.workspaceId)
        if (cursor) {
          const [name, id] = decodeCursor(nameCursorSchema, cursor)
          q = q.where(sql<boolean>`(w.name, w.id) > (${name}, ${id})`)
        }
        const rows = await q
          .orderBy('w.name')
          .orderBy('w.id')
          .limit(limit + 1)
          .execute()
        return page(rows.map(toWorkspace), limit, (w) => [w.name, w.id])
      })

      void v1.register(
        (ws, _o, wsDone) => {
          // A workspace exists for the caller only if the caller is a principal in it.
          ws.addHook('preHandler', async (request) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            request.principal = await workspaceActor(db, request.identity, workspaceId)
          })

          ws.get('/hubs', async (request): Promise<Page<Folder>> => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const { limit, cursor } = parse(pageQuerySchema, request.query)
            let q = db
              .selectFrom('folder')
              .selectAll()
              .where('workspace_id', '=', workspaceId)
              .where('parent_id', 'is', null)
            // An agent sees its one hub (D28). People: hub grants arrive with #43.
            if (request.identity.kind === 'agent') q = q.where('id', '=', request.identity.hubId)
            if (cursor) {
              const [name, id] = decodeCursor(nameCursorSchema, cursor)
              q = q.where(sql<boolean>`(name, id) > (${name}, ${id})`)
            }
            const rows = await q
              .orderBy('name')
              .orderBy('id')
              .limit(limit + 1)
              .execute()
            return page(rows.map(toFolder), limit, (h) => [h.name, h.id])
          })

          ws.get('/hubs/:hubId', async (request): Promise<HubDescription> => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            agentHubCheck(request.identity, request.principal, hubId, 'hub.read', 'Hub')
            const folders = await db
              .selectFrom('folder')
              .selectAll()
              .where('workspace_id', '=', workspaceId)
              .where('hub_id', '=', hubId)
              .orderBy(sql`parent_id IS NULL`, 'desc')
              .orderBy('name')
              .orderBy('id')
              .limit(maxHubEntries + 2)
              .execute()
            const hub = folders[0]
            if (hub?.id !== hubId) throw notFound('Hub')
            const [attributes, folderAttributes] = await Promise.all([
              db
                .selectFrom('attribute')
                .selectAll()
                .where('workspace_id', '=', workspaceId)
                .where('hub_id', '=', hubId)
                .orderBy('name')
                .orderBy('id')
                .limit(maxHubEntries + 1)
                .execute(),
              db
                .selectFrom('folder_attribute')
                .selectAll()
                .where('workspace_id', '=', workspaceId)
                .where('hub_id', '=', hubId)
                .orderBy('folder_id')
                .orderBy('position')
                .limit(faCap + 1)
                .execute(),
            ])
            // Each list is fetched with one extra row, which only says whether it was cut off.
            const subfolders = folders.slice(1)
            return {
              hub: toFolder(hub),
              folders: subfolders.slice(0, maxHubEntries).map(toFolder),
              attributes: attributes.slice(0, maxHubEntries).map(toAttribute),
              folderAttributes: folderAttributes.slice(0, faCap).map(toFolderAttribute),
              truncated: {
                folders: subfolders.length > maxHubEntries,
                attributes: attributes.length > maxHubEntries,
                folderAttributes: folderAttributes.length > faCap,
              },
            }
          })

          ws.post('/query', async (request) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const query = parse(itemQuerySchema, request.body)
            if (request.identity.kind === 'agent') {
              const hubId = await folderHub(workspaceId, query.from)
              agentHubCheck(request.identity, request.principal, hubId, 'hub.read', 'Folder')
            }
            return queryItems(db, workspaceId, query)
          })

          ws.post('/items', async (request, reply) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const body = parse(createItemSchema, request.body)
            if (request.identity.kind === 'agent') {
              const hubId = await folderHub(workspaceId, body.folderId)
              agentHubCheck(request.identity, request.principal, hubId, 'item.write', 'Folder')
            }
            const item = await createItem(db, workspaceId, request.principal.id, body)
            return reply.status(201).send(item)
          })

          ws.get('/items/:itemId', async (request) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const item = await getItem(db, workspaceId, itemId)
            agentHubCheck(request.identity, request.principal, item.hubId, 'hub.read', 'Item')
            return item
          })

          ws.patch('/items/:itemId', async (request) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const body = parse(patchItemSchema, request.body)
            if (request.identity.kind === 'agent') {
              const hubId = await itemHub(workspaceId, itemId)
              agentHubCheck(request.identity, request.principal, hubId, 'item.write', 'Item')
            }
            return patchItem(db, workspaceId, request.principal.id, itemId, body)
          })

          ws.delete('/items/:itemId', async (request, reply) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const { version } = parse(deleteItemQuerySchema, request.query)
            if (request.identity.kind === 'agent') {
              const hubId = await itemHub(workspaceId, itemId)
              agentHubCheck(request.identity, request.principal, hubId, 'item.write', 'Item')
            }
            await deleteItem(db, workspaceId, request.principal.id, itemId, version)
            return reply.status(204).send()
          })

          ws.post('/hubs/:hubId/agent-keys', async (request, reply) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const body = parse(createAgentKeySchema, request.body)
            const created = await createAgentKey(db, workspaceId, request.principal, hubId, body)
            return reply.status(201).header('cache-control', 'no-store').send(created)
          })

          ws.get('/hubs/:hubId/agent-keys', async (request) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const query = parse(pageQuerySchema, request.query)
            return listAgentKeys(db, workspaceId, request.principal, hubId, query)
          })

          ws.post('/agent-keys/:keyId/revoke', async (request) => {
            const { workspaceId, keyId } = parse(keyParams, request.params)
            return revokeAgentKey(db, workspaceId, request.principal, keyId)
          })

          wsDone()
        },
        { prefix: '/workspaces/:workspaceId' },
      )

      done()
    },
    { prefix: '/v1' },
  )

  /** The hub of a folder, or 404. Item hubs never change, so a check before the write holds. */
  async function folderHub(workspaceId: string, folderId: string): Promise<string> {
    const row = await db
      .selectFrom('folder')
      .select('hub_id')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folderId)
      .executeTakeFirst()
    if (!row) throw notFound('Folder')
    return row.hub_id
  }

  async function itemHub(workspaceId: string, itemId: string): Promise<string> {
    const row = await db
      .selectFrom('item')
      .select('hub_id')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!row) throw notFound('Item')
    return row.hub_id
  }

  return app
}

/** Rows were fetched with `limit + 1`; the extra row only says whether there is a next page. */
function page<T>(rows: T[], limit: number, key: (row: T) => string[]): Page<T> {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(key(last)) : null,
  }
}
