import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createItemSchema,
  deleteItemQuerySchema,
  idSchema,
  itemQuerySchema,
  pageQuerySchema,
  patchItemSchema,
  type Folder,
  type HubDescription,
  type Page,
  type Workspace,
} from '@16bit/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from './db/database.ts'
import { decodeCursor, encodeCursor, HttpError, notFound, parse } from './http.ts'
import { createItem, deleteItem, getItem, patchItem, queryItems } from './items.ts'
import { toAttribute, toFolder, toFolderAttribute, toWorkspace } from './mappers.ts'

export interface AppOptions {
  db: Kysely<Database>
  /** The M0 development key, sent as `Authorization: Bearer <key>`. */
  devApiKey: string
  /** The principal the development key acts as. It must exist in a workspace to see it. */
  devPrincipalId: string
}

/** Upper bound on folders and attributes returned by a hub description. */
export const MAX_HUB_ENTRIES = 1000

const nameCursorSchema = z.tuple([z.string(), z.string()])
const workspaceParams = z.object({ workspaceId: idSchema })
const hubParams = z.object({ workspaceId: idSchema, hubId: idSchema })
const itemParams = z.object({ workspaceId: idSchema, itemId: idSchema })

const digest = (value: string) => createHash('sha256').update(value).digest()

declare module 'fastify' {
  interface FastifyRequest {
    actor: string
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options
  const app = Fastify({ logger: false })
  const expectedKey = digest(options.devApiKey)

  app.decorateRequest('actor', '')

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send(error.body())
    // Fastify's own client errors, for example malformed JSON or a wrong content type.
    const status = (error as { statusCode?: number }).statusCode
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(400).send({ error: 'invalid_request', message: (error as Error).message })
    }
    console.error(error)
    return reply.status(500).send({ error: 'internal', message: 'Internal error' })
  })
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'Route not found' }),
  )

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
      v1.addHook('onRequest', (request, _reply, next) => {
        const header = request.headers.authorization ?? ''
        const match = /^Bearer (.+)$/.exec(header)
        if (!match?.[1] || !timingSafeEqual(digest(match[1]), expectedKey)) {
          next(new HttpError('unauthorized', 'A valid bearer token is required'))
          return
        }
        request.actor = options.devPrincipalId
        next()
      })

      v1.get('/workspaces', async (request): Promise<Page<Workspace>> => {
        const { limit, cursor } = parse(pageQuerySchema, request.query)
        let q = db
          .selectFrom('workspace as w')
          .innerJoin('principal as p', 'p.workspace_id', 'w.id')
          .selectAll('w')
          .where('p.id', '=', request.actor)
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
            const member = await db
              .selectFrom('principal')
              .select('id')
              .where('workspace_id', '=', workspaceId)
              .where('id', '=', request.actor)
              .executeTakeFirst()
            if (!member) throw notFound('Workspace')
          })

          ws.get('/hubs', async (request): Promise<Page<Folder>> => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const { limit, cursor } = parse(pageQuerySchema, request.query)
            let q = db
              .selectFrom('folder')
              .selectAll()
              .where('workspace_id', '=', workspaceId)
              .where('parent_id', 'is', null)
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
            const folders = await db
              .selectFrom('folder')
              .selectAll()
              .where('workspace_id', '=', workspaceId)
              .where('hub_id', '=', hubId)
              .orderBy(sql`parent_id IS NULL`, 'desc')
              .orderBy('name')
              .orderBy('id')
              .limit(MAX_HUB_ENTRIES + 1)
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
                .limit(MAX_HUB_ENTRIES)
                .execute(),
              db
                .selectFrom('folder_attribute')
                .selectAll()
                .where('workspace_id', '=', workspaceId)
                .where('hub_id', '=', hubId)
                .orderBy('folder_id')
                .orderBy('position')
                .limit(MAX_HUB_ENTRIES * 10)
                .execute(),
            ])
            return {
              hub: toFolder(hub),
              folders: folders.slice(1, MAX_HUB_ENTRIES + 1).map(toFolder),
              attributes: attributes.map(toAttribute),
              folderAttributes: folderAttributes.map(toFolderAttribute),
            }
          })

          ws.post('/query', async (request) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            return queryItems(db, workspaceId, parse(itemQuerySchema, request.body))
          })

          ws.post('/items', async (request, reply) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const item = await createItem(
              db,
              workspaceId,
              request.actor,
              parse(createItemSchema, request.body),
            )
            return reply.status(201).send(item)
          })

          ws.get('/items/:itemId', async (request) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            return getItem(db, workspaceId, itemId)
          })

          ws.patch('/items/:itemId', async (request) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const body = parse(patchItemSchema, request.body)
            return patchItem(db, workspaceId, request.actor, itemId, body)
          })

          ws.delete('/items/:itemId', async (request, reply) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const { version } = parse(deleteItemQuerySchema, request.query)
            await deleteItem(db, workspaceId, request.actor, itemId, version)
            return reply.status(204).send()
          })

          wsDone()
        },
        { prefix: '/workspaces/:workspaceId' },
      )

      done()
    },
    { prefix: '/v1' },
  )

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
