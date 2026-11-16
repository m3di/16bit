import { createHash, timingSafeEqual } from 'node:crypto'
import type { Subject, WorkspaceRole } from '@16bit/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/database.ts'
import { HttpError, notFound } from '../http.ts'
import {
  readCookie,
  resolveSession,
  SESSION_COOKIE,
  sessionCookie,
  type SessionPolicy,
} from './session.ts'

// Who is calling. Resolved once per request by `registerAuthHook`, before any handler:
//   1. a session cookie (people, D42),
//   2. a bearer token: the M0 development key until #51; #42 adds agent keys here,
//   3. no credentials: the dev owner if DEV_ANONYMOUS_AS_OWNER is on (D41), else nobody.
// Inside `/v1/workspaces/:workspaceId`, `resolvePrincipal` then turns the identity into the
// principal for that workspace: the `Subject` that `can()` from packages/core takes.

export type Identity =
  | { kind: 'person'; accountId: string; sessionIdHash: string }
  | { kind: 'dev'; principalId: string }

declare module 'fastify' {
  interface FastifyRequest {
    /** Null only on routes marked `auth: 'optional'`. */
    identity: Identity | null
    /** The caller's principal in the workspace of the path. Set inside workspace routes. */
    principal: Subject
  }
  interface FastifyContextConfig {
    /** Routes that run without credentials (sign-in, invite acceptance, sign-out). */
    auth?: 'optional'
  }
}

export interface AuthOptions {
  db: Kysely<Database>
  devApiKey: string
  devPrincipalId: string
  anonymousAsDevPrincipal: boolean
  session: SessionPolicy
  secureCookies: boolean
}

const digest = (value: string) => createHash('sha256').update(value).digest()
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF guard for requests a browser could send with the session cookie (D42). Browsers send
 * `Sec-Fetch-Site` on every request; older ones still send `Origin` on writes. A request with
 * neither did not come from a browser page, so the cookie was not attached by a third party.
 */
export function isSameOrigin(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site']
  if (site !== undefined) return site === 'same-origin' || site === 'none'
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === request.host
  } catch {
    return false
  }
}

export function registerAuthHook(v1: FastifyInstance, options: AuthOptions): void {
  const expectedKey = digest(options.devApiKey)

  v1.decorateRequest('identity', null)
  v1.decorateRequest('principal', null as unknown as Subject)

  v1.addHook('onRequest', async (request) => {
    const optional = request.routeOptions.config.auth === 'optional'
    const unsafe = !SAFE_METHODS.has(request.method)
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)

    // Sign-in and invite acceptance start sessions, so they are guarded too (login CSRF).
    if (unsafe && (token !== undefined || optional) && !isSameOrigin(request)) {
      throw new HttpError('forbidden', 'Cross-site request refused')
    }

    if (token) {
      const session = await resolveSession(options.db, token, options.session)
      if (session) {
        request.identity = {
          kind: 'person',
          accountId: session.accountId,
          sessionIdHash: session.idHash,
        }
        return
      }
    }

    const header = request.headers.authorization
    if (header !== undefined) {
      const match = /^Bearer (.+)$/.exec(header)
      if (match?.[1] && timingSafeEqual(digest(match[1]), expectedKey)) {
        request.identity = { kind: 'dev', principalId: options.devPrincipalId }
        return
      }
      if (optional) return
      throw new HttpError('unauthorized', 'A valid session or bearer token is required')
    }

    if (options.anonymousAsDevPrincipal) {
      request.identity = { kind: 'dev', principalId: options.devPrincipalId }
      return
    }
    if (!optional) {
      throw new HttpError('unauthorized', 'A valid session or bearer token is required')
    }
  })
}

/** Throws 401 unless the request has an identity. For `auth: 'optional'` routes. */
export function requireIdentity(request: FastifyRequest): Identity {
  if (!request.identity) {
    throw new HttpError('unauthorized', 'A valid session or bearer token is required')
  }
  return request.identity
}

export interface MembershipRow {
  workspace_id: string
  workspace_name: string
  workspace_created_at: Date
  principal_id: string
  workspace_role: WorkspaceRole
}

/**
 * An account's memberships, through the SECURITY DEFINER lookup (it keeps working under
 * row-level security, #44). Ordered by workspace name, then ID. Don't join `workspace` onto
 * it: before a workspace is set with `SET LOCAL`, RLS hides every row. Add the column to the
 * function instead.
 */
export function accountMemberships(db: Kysely<Database>, accountId: string) {
  return db.selectFrom(sql<MembershipRow>`account_memberships(${accountId})`.as('m')).selectAll()
}

/** The caller's principal in `workspaceId`, or a 404 so hidden workspaces aren't confirmed. */
export async function resolvePrincipal(
  db: Kysely<Database>,
  identity: Identity,
  workspaceId: string,
): Promise<Subject> {
  if (identity.kind === 'person') {
    const row = await accountMemberships(db, identity.accountId)
      .where('m.workspace_id', '=', workspaceId)
      .executeTakeFirst()
    if (!row) throw notFound('Workspace')
    return { id: row.principal_id, kind: 'user', workspaceRole: row.workspace_role }
  }
  const row = await db
    .selectFrom('principal')
    .select(['id', 'kind', 'workspace_role'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', identity.principalId)
    .executeTakeFirst()
  if (!row) throw notFound('Workspace')
  return { id: row.id, kind: row.kind, workspaceRole: row.workspace_role }
}

export function setSessionCookie(reply: FastifyReply, token: string, options: AuthOptions): void {
  reply.header(
    'set-cookie',
    sessionCookie(token, options.session.absoluteSeconds, options.secureCookies),
  )
}

export function clearSessionCookie(reply: FastifyReply, options: AuthOptions): void {
  reply.header('set-cookie', sessionCookie('', 0, options.secureCookies))
}
