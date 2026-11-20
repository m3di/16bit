import {
  can,
  changeMemberRoleSchema,
  changesQuerySchema,
  createAgentKeySchema,
  createAttributeSchema,
  createFolderSchema,
  createHubSchema,
  deleteAttributeQuerySchema,
  deleteFolderQuerySchema,
  createItemSchema,
  deleteItemQuerySchema,
  getItemQuerySchema,
  idSchema,
  itemQuerySchema,
  pageQuerySchema,
  patchItemSchema,
  setFolderAttributesSchema,
  setHubGrantSchema,
  updateAttributeSchema,
  updateFolderSchema,
  updateHubSchema,
  effectiveHubRole,
  type ChangesPage,
  type HubDescription,
  type HubListEntry,
  type ItemQueryResult,
  type ItemRead,
  type ItemWriteResult,
  type Page,
  type Workspace,
} from '@16bit/core'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import { createAgentKey, listAgentKeys, revokeAgentKey } from './agent-keys.ts'
import { checkHub, folderHub, itemHub } from './access.ts'
import { readChanges } from './changes.ts'
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
import { withScope, workspaceSeq } from './db/scope.ts'
import { decodeCursor, encodeCursor, HttpError, notFound, parse } from './http.ts'
import {
  backlinks,
  createItem,
  deleteItem,
  expandItem,
  getItem,
  patchItem,
  queryItems,
} from './items.ts'
import { toAttribute, toFolder, toFolderAttribute, toHub } from './mappers.ts'
import { idempotentWrite, type KnownMutation } from './mutations.ts'
import {
  changeMemberRole,
  createHub,
  listMembers,
  removeMember,
  requireMemberManager,
  revokeHubGrant,
  setHubGrant,
} from './members.ts'
import {
  attributeUsage,
  createAttribute,
  createFolder,
  deleteAttribute,
  deleteFolder,
  deleteHub,
  listHubGrants,
  setFolderAttributes,
  updateAttribute,
  updateFolder,
  updateHub,
} from './schema-writes.ts'
import { isAppRoute, registerWeb, sendAppShell } from './web.ts'

export interface AppOptions {
  /** Connects as the API's role, under row-level security (#44). */
  db: Kysely<Database>
  /** Cap on folders and on attributes in a hub description. Folder attributes get 10 times it. */
  maxHubEntries?: number
  /** Cap on linked items in one query or item response. Defaults to `MAX_LINKED_ITEMS`; lowered in tests. */
  maxLinkedItems?: number
  /** Cap on the `hidden` count of backlinks. Defaults to `MAX_HIDDEN_BACKLINKS`; lowered in tests. */
  maxHiddenBacklinks?: number
  /** Directory of the built web app. When set, the API also serves the dashboard (D34). */
  webRoot?: string
  /** Session lifetimes. Defaults to 30 days absolute, 7 days idle. */
  session?: SessionPolicy
  /** Adds `Secure` to the session cookie. Off only for plain-HTTP local development. */
  secureCookies?: boolean
  /** Refuses sign-in with the seeds' published `DEV_PASSWORD`. Set from `devPasswordRefused`. */
  refuseDevPassword?: boolean
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
const keyParams = z.object({ workspaceId: idSchema, keyId: idSchema })
const memberParams = z.object({ workspaceId: idSchema, principalId: idSchema })
const grantParams = z.object({ workspaceId: idSchema, hubId: idSchema, principalId: idSchema })
const folderParams = z.object({ workspaceId: idSchema, folderId: idSchema })
const attributeParams = z.object({ workspaceId: idSchema, attributeId: idSchema })

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options
  const maxHubEntries = options.maxHubEntries ?? MAX_HUB_ENTRIES
  const faCap = maxHubEntries * 10
  const { maxLinkedItems, maxHiddenBacklinks } = options
  const app = Fastify({ logger: false })
  const auth = {
    db,
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
      registerAuthRoutes(v1, {
        ...auth,
        emailLimiter,
        ipLimiter,
        refuseDevPassword: options.refuseDevPassword ?? false,
      })

      v1.get('/workspaces', async (request): Promise<Page<Workspace>> => {
        const identity = requireIdentity(request)
        const { limit, cursor } = parse(pageQuerySchema, request.query)
        const after = cursor ? decodeCursor(nameCursorSchema, cursor) : null
        if (identity.kind === 'person') {
          // Only through the membership lookup: it runs before any workspace is set, so a
          // direct read of `workspace` here would come back empty under row-level security.
          let q = accountMemberships(db, identity.accountId)
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
            createdAt: r.workspace_created_at.toISOString(),
          }))
          return page(workspaces, limit, (w) => [w.name, w.id])
        }
        // An agent has exactly one workspace, its key's, taken from the key lookup (RLS-safe
        // like the branch above). One row never yields a next cursor, so any cursor is past it.
        const workspace: Workspace = {
          id: identity.workspaceId,
          name: identity.workspaceName,
          createdAt: identity.workspaceCreatedAt.toISOString(),
        }
        return page(after ? [] : [workspace], limit, (w) => [w.name, w.id])
      })

      void v1.register(
        (ws, _o, wsDone) => {
          /** Runs a handler's queries in the caller's RLS scope: one transaction per request. */
          const scoped = <T>(
            request: FastifyRequest,
            fn: (trx: Transaction<Database>) => Promise<T>,
          ): Promise<T> =>
            withScope(
              db,
              {
                workspaceId: parse(workspaceParams, request.params).workspaceId,
                principalId: request.principal.id,
              },
              fn,
            )
          /**
           * `scoped`, in one `REPEATABLE READ READ ONLY` transaction, for reads that carry the
           * workspace `seq`: it and the rows come from one snapshot (D58).
           */
          const snapshot = <T>(
            request: FastifyRequest,
            fn: (trx: Transaction<Database>) => Promise<T>,
          ): Promise<T> =>
            withScope(
              db,
              {
                workspaceId: parse(workspaceParams, request.params).workspaceId,
                principalId: request.principal.id,
              },
              fn,
              { snapshot: true },
            )
          /**
           * A retry's answer for create and patch (D59): the item as it is now, or 404 if it
           * has been deleted since, with the `seq` read before it.
           */
          const currentItem = async (
            trx: Transaction<Database>,
            workspaceId: string,
            first: KnownMutation,
          ): Promise<ItemWriteResult> => {
            const seq = await workspaceSeq(trx, workspaceId)
            return { ...(await getItem(trx, workspaceId, first.itemId)), seq }
          }

          // A workspace exists for the caller only if the caller is a principal in it.
          ws.addHook('preHandler', async (request) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            request.principal = await resolvePrincipal(db, requireIdentity(request), workspaceId)
          })

          registerInviteRoutes(ws, db)

          ws.get('/hubs', async (request): Promise<Page<HubListEntry>> => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const { limit, cursor } = parse(pageQuerySchema, request.query)
            const me = request.principal
            // Owners and admins see every hub's name; everyone else, agents included, only
            // the hubs they hold a grant on (docs/ROLES.md).
            const listAll = can(me, 'hub.listAll') === 'allow'
            const q = (trx: Transaction<Database>) =>
              trx
                .selectFrom('folder as f')
                .leftJoin('hub_grant as g', (j) =>
                  j
                    .onRef('g.workspace_id', '=', 'f.workspace_id')
                    .onRef('g.hub_id', '=', 'f.id')
                    .on('g.principal_id', '=', me.id),
                )
                .selectAll('f')
                .select('g.hub_role')
                .where('f.workspace_id', '=', workspaceId)
                .where('f.parent_id', 'is', null)
            const after = cursor ? decodeCursor(nameCursorSchema, cursor) : null
            const rows = await scoped(request, (trx) => {
              let sel = q(trx)
              if (!listAll) sel = sel.where('g.principal_id', 'is not', null)
              if (after) sel = sel.where(sql<boolean>`(f.name, f.id) > (${after[0]}, ${after[1]})`)
              return sel
                .orderBy('f.name')
                .orderBy('f.id')
                .limit(limit + 1)
                .execute()
            })
            const hubs = rows.map(({ hub_role, ...row }): HubListEntry => {
              const hubRole = effectiveHubRole(me, hub_role)
              if (hubRole) return { ...toFolder(row), access: 'granted', hubRole }
              // Name only: not even the item count of a hub the caller can't see into.
              return {
                access: 'none',
                workspaceId: row.workspace_id,
                id: row.id,
                name: row.name,
                color: toFolder(row).color,
              }
            })
            return page(hubs, limit, (h) => [h.name, h.id])
          })

          ws.post('/hubs', async (request, reply) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const body = parse(createHubSchema, request.body)
            const hub = await scoped(request, (trx) =>
              createHub(trx, workspaceId, request.principal, body),
            )
            return reply.status(201).send(hub)
          })

          ws.put('/hubs/:hubId/grants/:principalId', async (request) => {
            const { workspaceId, hubId, principalId } = parse(grantParams, request.params)
            const { hubRole } = parse(setHubGrantSchema, request.body)
            return scoped(request, (trx) =>
              setHubGrant(trx, workspaceId, request.principal, hubId, principalId, hubRole),
            )
          })

          ws.delete('/hubs/:hubId/grants/:principalId', async (request, reply) => {
            const { workspaceId, hubId, principalId } = parse(grantParams, request.params)
            await scoped(request, (trx) =>
              revokeHubGrant(trx, workspaceId, request.principal, hubId, principalId),
            )
            return reply.status(204).send()
          })

          ws.get('/members', async (request) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const query = parse(pageQuerySchema, request.query)
            return scoped(request, (trx) => listMembers(trx, workspaceId, request.principal, query))
          })

          ws.patch('/members/:principalId', async (request) => {
            const { workspaceId, principalId } = parse(memberParams, request.params)
            const { workspaceRole } = parse(changeMemberRoleSchema, request.body)
            // Non-managers are refused before the transaction (#71 review): no owner rows locked.
            requireMemberManager(request.principal)
            return scoped(request, (trx) =>
              changeMemberRole(trx, workspaceId, request.principal, principalId, workspaceRole),
            )
          })

          ws.delete('/members/:principalId', async (request, reply) => {
            const { workspaceId, principalId } = parse(memberParams, request.params)
            requireMemberManager(request.principal)
            await scoped(request, (trx) =>
              removeMember(trx, workspaceId, request.principal, principalId),
            )
            return reply.status(204).send()
          })

          ws.get('/hubs/:hubId', async (request): Promise<HubDescription> => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            return snapshot(request, async (db) => {
              const hubRole = await checkHub(
                db,
                workspaceId,
                request.principal,
                hubId,
                'hub.read',
                'Hub',
              )
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
                hub: toHub(hub),
                hubRole,
                folders: subfolders.slice(0, maxHubEntries).map(toFolder),
                attributes: attributes.slice(0, maxHubEntries).map(toAttribute),
                folderAttributes: folderAttributes.slice(0, faCap).map(toFolderAttribute),
                truncated: {
                  folders: subfolders.length > maxHubEntries,
                  attributes: attributes.length > maxHubEntries,
                  folderAttributes: folderAttributes.length > faCap,
                },
                seq: await workspaceSeq(db, workspaceId),
              }
            })
          })

          ws.post('/query', async (request) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const query = parse(itemQuerySchema, request.body)
            // In the contract since #168; served from M3-05 (D61). Refused until then rather
            // than ignored, so no client reads a window or a total that is not there.
            if (query.offset !== undefined || query.count || query.order === 'number') {
              throw new HttpError(
                'invalid_request',
                'offset, count and order "number" are not supported yet',
              )
            }
            return snapshot(request, async (trx): Promise<ItemQueryResult> => {
              const hubId = await folderHub(trx, workspaceId, query.from)
              await checkHub(trx, workspaceId, request.principal, hubId, 'hub.read', 'Folder')
              const result = await queryItems(trx, workspaceId, request.principal, query, {
                maxLinkedItems,
              })
              return { ...result, seq: await workspaceSeq(trx, workspaceId) }
            })
          })

          // Item writes check the caller's grant in the write's own transaction and hold it
          // (FOR SHARE) until commit, so a revoke can't land between the check and the write.
          // With a `clientMutationId`, a retry answers as the first attempt did and writes
          // nothing (D59, mutations.ts). A write's `seq` is read in its own transaction, which
          // still holds the workspace row: it is the write's own revision.
          const run =
            (request: FastifyRequest) =>
            <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
              scoped(request, fn)

          ws.post('/items', async (request, reply) => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const body = parse(createItemSchema, request.body)
            const actor = request.principal.id
            const item = await idempotentWrite(
              run(request),
              { workspaceId, actor, clientMutationId: body.clientMutationId },
              { op: 'create', itemId: body.id, folderId: body.folderId },
              async (trx): Promise<ItemWriteResult> => {
                const hubId = await folderHub(trx, workspaceId, body.folderId)
                await checkHub(trx, workspaceId, request.principal, hubId, 'item.write', 'Folder')
                const created = await createItem(trx, workspaceId, actor, body)
                return { ...created, seq: await workspaceSeq(trx, workspaceId) }
              },
              (trx, first) => currentItem(trx, workspaceId, first),
            )
            return reply.status(201).send(item)
          })

          ws.get('/changes', async (request): Promise<ChangesPage> => {
            const { workspaceId } = parse(workspaceParams, request.params)
            const { after, limit } = parse(changesQuerySchema, request.query)
            // Every hub the caller can read, as row-level security decides; an agent's is its own.
            return snapshot(request, (trx) => readChanges(trx, workspaceId, { after, limit }))
          })

          ws.get('/items/:itemId', async (request): Promise<ItemRead> => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const { expand } = parse(getItemQuerySchema, request.query)
            return snapshot(request, async (trx) => {
              const item = await getItem(trx, workspaceId, itemId)
              await checkHub(trx, workspaceId, request.principal, item.hubId, 'hub.read', 'Item')
              const seq = await workspaceSeq(trx, workspaceId)
              if (expand.length === 0) return { ...item, seq }
              const read = await expandItem(trx, workspaceId, request.principal, item, expand, {
                maxLinkedItems,
              })
              return { ...read, seq }
            })
          })

          ws.get('/items/:itemId/backlinks', async (request) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const page = parse(pageQuerySchema, request.query)
            return scoped(request, (trx) =>
              backlinks(trx, workspaceId, request.principal, itemId, page, maxHiddenBacklinks),
            )
          })

          ws.patch('/items/:itemId', async (request) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const body = parse(patchItemSchema, request.body)
            const actor = request.principal.id
            return idempotentWrite(
              run(request),
              { workspaceId, actor, clientMutationId: body.clientMutationId },
              { op: 'update', itemId },
              async (trx): Promise<ItemWriteResult> => {
                const hubId = await itemHub(trx, workspaceId, itemId)
                await checkHub(trx, workspaceId, request.principal, hubId, 'item.write', 'Item')
                const patched = await patchItem(trx, workspaceId, actor, itemId, body)
                return { ...patched, seq: await workspaceSeq(trx, workspaceId) }
              },
              (trx, first) => currentItem(trx, workspaceId, first),
            )
          })

          ws.delete('/items/:itemId', async (request, reply) => {
            const { workspaceId, itemId } = parse(itemParams, request.params)
            const { version, clientMutationId } = parse(deleteItemQuerySchema, request.query)
            const actor = request.principal.id
            await idempotentWrite(
              run(request),
              { workspaceId, actor, clientMutationId },
              { op: 'delete', itemId },
              async (trx) => {
                const hubId = await itemHub(trx, workspaceId, itemId)
                await checkHub(trx, workspaceId, request.principal, hubId, 'item.write', 'Item')
                await deleteItem(trx, workspaceId, actor, itemId, version, clientMutationId)
              },
              // The first delete answered 204; so does its retry.
              () => Promise.resolve(),
            )
            return reply.status(204).send()
          })

          ws.post('/hubs/:hubId/agent-keys', async (request, reply) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const body = parse(createAgentKeySchema, request.body)
            const created = await scoped(request, (trx) =>
              createAgentKey(trx, workspaceId, request.principal, hubId, body),
            )
            return reply.status(201).header('cache-control', 'no-store').send(created)
          })

          ws.get('/hubs/:hubId/agent-keys', async (request) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const query = parse(pageQuerySchema, request.query)
            return scoped(request, (trx) =>
              listAgentKeys(trx, workspaceId, request.principal, hubId, query),
            )
          })

          ws.post('/agent-keys/:keyId/revoke', async (request) => {
            const { workspaceId, keyId } = parse(keyParams, request.params)
            return scoped(request, (trx) =>
              revokeAgentKey(trx, workspaceId, request.principal, keyId),
            )
          })

          // Schema writes for hub settings (#112, schema-writes.ts).

          ws.patch('/hubs/:hubId', async (request) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const body = parse(updateHubSchema, request.body)
            return scoped(request, (trx) =>
              updateHub(trx, workspaceId, request.principal, hubId, body),
            )
          })

          ws.delete('/hubs/:hubId', async (request, reply) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const { version } = parse(deleteFolderQuerySchema, request.query)
            await scoped(request, (trx) =>
              deleteHub(trx, workspaceId, request.principal, hubId, version),
            )
            return reply.status(204).send()
          })

          ws.get('/hubs/:hubId/grants', async (request) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const query = parse(pageQuerySchema, request.query)
            return scoped(request, (trx) =>
              listHubGrants(trx, workspaceId, request.principal, hubId, query),
            )
          })

          ws.post('/hubs/:hubId/folders', async (request, reply) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const body = parse(createFolderSchema, request.body)
            const folder = await scoped(request, (trx) =>
              createFolder(trx, workspaceId, request.principal, hubId, body),
            )
            return reply.status(201).send(folder)
          })

          ws.patch('/folders/:folderId', async (request) => {
            const { workspaceId, folderId } = parse(folderParams, request.params)
            const body = parse(updateFolderSchema, request.body)
            return scoped(request, (trx) =>
              updateFolder(trx, workspaceId, request.principal, folderId, body),
            )
          })

          ws.delete('/folders/:folderId', async (request, reply) => {
            const { workspaceId, folderId } = parse(folderParams, request.params)
            const { version } = parse(deleteFolderQuerySchema, request.query)
            await scoped(request, (trx) =>
              deleteFolder(trx, workspaceId, request.principal, folderId, version),
            )
            return reply.status(204).send()
          })

          ws.put('/folders/:folderId/attributes', async (request) => {
            const { workspaceId, folderId } = parse(folderParams, request.params)
            const body = parse(setFolderAttributesSchema, request.body)
            return scoped(request, (trx) =>
              setFolderAttributes(trx, workspaceId, request.principal, folderId, body),
            )
          })

          ws.post('/hubs/:hubId/attributes', async (request, reply) => {
            const { workspaceId, hubId } = parse(hubParams, request.params)
            const body = parse(createAttributeSchema, request.body)
            const attribute = await scoped(request, (trx) =>
              createAttribute(trx, workspaceId, request.principal, hubId, body),
            )
            return reply.status(201).send(attribute)
          })

          ws.get('/attributes/:attributeId/usage', async (request) => {
            const { workspaceId, attributeId } = parse(attributeParams, request.params)
            return scoped(request, (trx) =>
              attributeUsage(trx, workspaceId, request.principal, attributeId),
            )
          })

          ws.patch('/attributes/:attributeId', async (request) => {
            const { workspaceId, attributeId } = parse(attributeParams, request.params)
            const body = parse(updateAttributeSchema, request.body)
            return scoped(request, (trx) =>
              updateAttribute(trx, workspaceId, request.principal, attributeId, body),
            )
          })

          ws.delete('/attributes/:attributeId', async (request, reply) => {
            const { workspaceId, attributeId } = parse(attributeParams, request.params)
            const query = parse(deleteAttributeQuerySchema, request.query)
            await scoped(request, (trx) =>
              deleteAttribute(trx, workspaceId, request.principal, attributeId, query),
            )
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
