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
import {
  registerAuthHook,
  requireIdentity,
  resolvePrincipal,
  accountMemberships,
} from './auth/auth.ts'
import { RateLimiter, type RateLimitPolicy } from './auth/rate-limit.ts'
import { registerAuthRoutes, registerInviteRoutes } from './auth/routes.ts'
import { DEFAULT_SESSION_POLICY, type SessionPolicy } from './auth/session.ts'
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
  /** Session lifetimes. Defaults to 30 days absolute, 7 days idle. */
  session?: SessionPolicy
  /** Adds `Secure` to the session cookie. Off only for plain-HTTP local development. */
  secureCookies?: boolean
  /** Sign-in attempts per email. Defaults to 10 per 15 minutes. */
  loginPerEmail?: RateLimitPolicy
  /** Sign-in and invite acceptance attempts per client IP. Defaults to 100 per 15 minutes. */
  loginPerIp?: RateLimitPolicy
}

/** Default cap on folders and attributes returned by a hub description. */
export const MAX_HUB_ENTRIES = 1000

const nameCursorSchema = z.tuple([z.string(), z.string()])
const workspaceParams = z.object({ workspaceId: idSchema })
const hubParams = z.object({ workspaceId: idSchema, hubId: idSchema })
const itemParams = z.object({ workspaceId: idSchema, itemId: idSchema })

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options
  const maxHubEntries = options.maxHubEntries ?? MAX_HUB_ENTRIES
  const faCap = maxHubEntries * 10
  const app = Fastify({ logger: false })
  const auth = {
    db,
    devApiKey: options.devApiKey,
    devPrincipalId: options.devPrincipalId,
    anonymousAsDevPrincipal: options.anonymousAsDevPrincipal ?? false,
    session: options.session ?? DEFAULT_SESSION_POLICY,
    secureCookies: options.secureCookies ?? true,
  }
  const emailLimiter = new RateLimiter(options.loginPerEmail ?? { max: 10, windowSeconds: 900 })
  const ipLimiter = new RateLimiter(options.loginPerIp ?? { max: 100, windowSeconds: 900 })

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
      registerAuthHook(v1, auth)
      registerAuthRoutes(v1, { ...auth, emailLimiter, ipLimiter })

      v1.get('/workspaces', async (request): Promise<Page<Workspace>> => {
        const identity = requireIdentity(request)
        const { limit, cursor } = parse(pageQuerySchema, request.query)
        const after = cursor ? decodeCursor(nameCursorSchema, cursor) : null
        if (identity.kind === 'person') {
          // Through the membership lookup, which keeps working under row-level security.
          let q = accountMemberships(db, identity.accountId)
            .innerJoin('workspace as w', 'w.id', 'm.workspace_id')
            .select('w.created_at')
          if (after)
            q = q.where(
              sql<boolean>`(m.workspace_name, m.workspace_id) > (${after[0]}, ${after[1]})`,
            )
          const rows = await q
            .orderBy('m.workspace_name')
            .orderBy('m.workspace_id')
            .limit(limit + 1)
            .execute()
          const workspaces = rows.map((r): Workspace => ({
            id: r.workspace_id,
            name: r.workspace_name,
            createdAt: r.created_at.toISOString(),
          }))
          return page(workspaces, limit, (w) => [w.name, w.id])
        }
        let q = db
          .selectFrom('workspace as w')
          .innerJoin('principal as p', 'p.workspace_id', 'w.id')
          .selectAll('w')
          .where('p.id', '=', identity.principalId)
        if (after) q = q.where(sql<boolean>`(w.name, w.id) > (${after[0]}, ${after[1]})`)
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
            request.principal = await resolvePrincipal(db, requireIdentity(request), workspaceId)
          })

          registerInviteRoutes(ws, db)

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
            return queryItems(db, workspaceId, parse(itemQuerySchema, request.body))
          })

          ws.post('/items', async (request, reply) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const item = await createItem(
              db,
              workspaceId,
              request.principal.id,
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
            return patchItem(db, workspaceId, request.principal.id, itemId, body)
          })

          ws.delete('/items/:itemId', async (request, reply) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const { version } = parse(deleteItemQuerySchema, request.query)
            await deleteItem(db, workspaceId, request.principal.id, itemId, version)
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
