import { randomUUID } from 'node:crypto'
import {
  acceptInviteSchema,
  can,
  createInviteSchema,
  idSchema,
  inviteTokenSchema,
  loginRequestSchema,
  MAX_ME_MEMBERSHIPS,
  pageQuerySchema,
  type AcceptedInvite,
  type CreatedInvite,
  type Invite,
  type Me,
  type Page,
} from '@16bit/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { appendAccessLog } from '../access-log.ts'
import type { Database } from '../db/database.ts'
import { withScope } from '../db/scope.ts'
import { DEV_PASSWORD, DEV_PASSWORD_REFUSED } from '../dev-accounts.ts'
import { HttpError, parse } from '../http.ts'
import { listInvites, revokeInvite } from '../invites.ts'
import {
  accountMemberships,
  clearSessionCookie,
  requireIdentity,
  setSessionCookie,
  type AuthOptions,
} from './auth.ts'
import { hashPassword, verifyDummy, verifyPassword } from './password.ts'
import type { RateLimiter } from './rate-limit.ts'
import { createSession, deleteSession, hashToken, newToken } from './session.ts'

// Installation-level routes (D46): /v1/auth/* and /v1/me. Invite creation is registered
// inside the workspace scope with `registerInviteRoutes`.

export interface AuthRouteOptions extends AuthOptions {
  /** Sign-in attempts per email address. */
  emailLimiter: RateLimiter
  /** Sign-in and invite acceptance attempts per client IP. */
  ipLimiter: RateLimiter
  /** Refuses the seeds' published password (production without ALLOW_DEV_PASSWORD=1). */
  refuseDevPassword: boolean
}

const optional = { config: { auth: 'optional' as const } }
const tokenParams = z.object({ token: inviteTokenSchema })
const workspaceParams = z.object({ workspaceId: idSchema })
const inviteParams = z.object({ workspaceId: idSchema, inviteId: idSchema })

/** Postgres error code, from the custom SQLSTATEs raised by `redeem_invite`. */
const pgCode = (error: unknown) => (error as { code?: unknown }).code

function tooMany(reply: FastifyReply, seconds: number) {
  return reply
    .status(429)
    .header('retry-after', String(seconds))
    .send({ error: 'rate_limited', message: 'Too many attempts. Try again later.' })
}

async function me(db: Kysely<Database>, accountId: string): Promise<Me> {
  const account = await db
    .selectFrom('account')
    .select(['id', 'email', 'name'])
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow()
  const rows = await accountMemberships(db, accountId)
    .limit(MAX_ME_MEMBERSHIPS + 1)
    .execute()
  return {
    kind: 'person',
    account,
    memberships: rows.slice(0, MAX_ME_MEMBERSHIPS).map((r) => ({
      workspace: { id: r.workspace_id, name: r.workspace_name },
      principalId: r.principal_id,
      workspaceRole: r.workspace_role,
    })),
    truncated: rows.length > MAX_ME_MEMBERSHIPS,
  }
}

export function registerAuthRoutes(v1: FastifyInstance, options: AuthRouteOptions): void {
  const { db } = options

  /** Signs the account in with a fresh session, ending the one the request came with. */
  async function startSession(
    reply: FastifyReply,
    accountId: string,
    previous: string | undefined,
  ) {
    if (previous) await deleteSession(db, previous)
    setSessionCookie(reply, await createSession(db, accountId, options.session), options)
  }

  v1.post('/auth/login', optional, async (request, reply) => {
    const { email, password } = parse(loginRequestSchema, request.body)
    // Counted before the password check, for unknown emails too, so the limit tells nothing.
    const wait = Math.max(options.ipLimiter.hit(request.ip), options.emailLimiter.hit(email))
    if (wait) return tooMany(reply, wait)
    // Before any lookup, so the answer is the same for every email.
    if (options.refuseDevPassword && password === DEV_PASSWORD) {
      throw new HttpError('unauthorized', 'The development password is refused in production')
    }

    const account = await db
      .selectFrom('account')
      .select(['id', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst()
    // An account with no password signs in only by external login (D72): it gets the same
    // answer, in the same time, as an unknown email.
    const ok = account?.password_hash
      ? await verifyPassword(password, account.password_hash)
      : await verifyDummy(password)
    if (!account || !ok) throw new HttpError('unauthorized', 'Email or password is incorrect')

    const previous =
      request.identity?.kind === 'person' ? request.identity.sessionIdHash : undefined
    await startSession(reply, account.id, previous)
    return me(db, account.id)
  })

  v1.post('/auth/logout', optional, async (request, reply) => {
    if (request.identity?.kind === 'person') {
      await deleteSession(db, request.identity.sessionIdHash)
    }
    clearSessionCookie(reply, options)
    return reply.status(204).send()
  })

  v1.get('/me', async (request): Promise<Me> => {
    const identity = requireIdentity(request)
    if (identity.kind === 'person') return me(db, identity.accountId)
    // Names come from the key lookup, so nothing is read before a workspace is set (#44).
    return {
      kind: 'agent',
      principalId: identity.principalId,
      workspace: { id: identity.workspaceId, name: identity.workspaceName },
      hub: { id: identity.hubId, name: identity.hubName },
      hubRole: identity.hubRole,
    }
  })

  v1.post('/auth/invites/:token', optional, async (request, reply) => {
    const wait = options.ipLimiter.hit(request.ip)
    if (wait) return tooMany(reply, wait)
    const { token } = parse(tokenParams, request.params)
    const body = parse(acceptInviteSchema, request.body)
    // The contract has the external-login form from #205; trusted-header sign-in serves it from
    // #213. Until then it is refused, before the invite is looked at.
    if ('email' in body && !('password' in body)) {
      throw new HttpError('invalid_request', 'password: required until external logins are served')
    }
    const tokenHash = hashToken(token)
    const signedIn = request.identity?.kind === 'person' ? request.identity : undefined

    let accountId: string
    let redeemed: AcceptedInvite
    // Before the invite is looked at, so a refused password leaves it unused.
    if ('email' in body && options.refuseDevPassword && body.password === DEV_PASSWORD) {
      throw new HttpError('invalid_request', DEV_PASSWORD_REFUSED)
    }

    try {
      if ('email' in body) {
        const passwordHash = await hashPassword(body.password)
        ;({ accountId, redeemed } = await db.transaction().execute(async (trx) => {
          const created = await trx
            .insertInto('account')
            .values({
              id: randomUUID(),
              email: body.email,
              password_hash: passwordHash,
              name: body.name,
            })
            .onConflict((oc) => oc.column('email').doNothing())
            .returning('id')
            .executeTakeFirst()
          if (created)
            return { accountId: created.id, redeemed: await redeem(trx, tokenHash, created.id) }
          // The email has an account. Only say so to someone holding a valid invite: try the
          // invite with that account, then roll everything back.
          const existing = await trx
            .selectFrom('account')
            .select('id')
            .where('email', '=', body.email)
            .executeTakeFirstOrThrow()
          try {
            await redeem(trx, tokenHash, existing.id)
          } catch (error) {
            if (pgCode(error) !== '16B02') throw error
          }
          throw new HttpError(
            'email_taken',
            'An account with this email exists. Sign in, then accept the invite.',
          )
        }))
        await startSession(reply, accountId, signedIn?.sessionIdHash)
      } else {
        if (!signedIn) {
          throw new HttpError('unauthorized', 'Sign in, or send the details of a new account')
        }
        accountId = signedIn.accountId
        redeemed = await db.transaction().execute((trx) => redeem(trx, tokenHash, accountId))
      }
    } catch (error) {
      if (pgCode(error) === '16B01') {
        throw new HttpError('not_found', 'Invite not found, used, or expired')
      }
      if (pgCode(error) === '16B02') {
        throw new HttpError('already_member', 'This account already belongs to the workspace')
      }
      throw error
    }
    return reply.status(201).send(redeemed)
  })
}

async function redeem(
  trx: Kysely<Database>,
  tokenHash: string,
  accountId: string,
): Promise<AcceptedInvite> {
  const { rows } = await sql<{ workspace_id: string; principal_id: string }>`
    SELECT workspace_id, principal_id FROM redeem_invite(${tokenHash}, ${accountId})
  `.execute(trx)
  const row = rows[0]
  if (!row) throw new Error('redeem_invite returned no row')
  return { workspaceId: row.workspace_id, principalId: row.principal_id }
}

/** `POST /v1/workspaces/:workspaceId/invites`. Registered inside the workspace scope. */
export function registerInviteRoutes(ws: FastifyInstance, db: Kysely<Database>): void {
  ws.get('/invites', async (request): Promise<Page<Invite>> => {
    const { workspaceId } = parse(workspaceParams, request.params)
    const query = parse(pageQuerySchema, request.query)
    const scope = { workspaceId, principalId: request.principal.id }
    return withScope(db, scope, (trx) => listInvites(trx, workspaceId, request.principal, query))
  })

  ws.post('/invites/:inviteId/revoke', async (request, reply) => {
    const { workspaceId, inviteId } = parse(inviteParams, request.params)
    const scope = { workspaceId, principalId: request.principal.id }
    await withScope(db, scope, (trx) => revokeInvite(trx, workspaceId, request.principal, inviteId))
    return reply.status(204).send()
  })

  ws.post('/invites', async (request, reply): Promise<CreatedInvite> => {
    const { workspaceId } = parse(workspaceParams, request.params)
    const input = parse(createInviteSchema, request.body)
    // In the contract from #205 (D72); served with trusted-header sign-in (#213). Refused, not
    // ignored: an invite meant for one login must not become one anybody can accept.
    if (input.externalLogin !== undefined) {
      throw new HttpError('invalid_request', 'externalLogin: not supported yet')
    }
    if (can(request.principal, 'member.invite', { role: input.workspaceRole }) !== 'allow') {
      throw new HttpError('forbidden', 'Your role cannot create this invite')
    }
    const token = newToken()
    const scope = { workspaceId, principalId: request.principal.id }
    const invite = await withScope(db, scope, async (trx) => {
      const row = await trx
        .insertInto('invite')
        .values({
          workspace_id: workspaceId,
          id: randomUUID(),
          token_hash: hashToken(token),
          workspace_role: input.workspaceRole,
          created_by: request.principal.id,
          expires_at: sql<Date>`now() + make_interval(days => ${input.expiresInDays})`,
          used_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await appendAccessLog(trx, {
        workspaceId,
        actor: request.principal.id,
        action: 'invite.create',
        target: row.id,
        detail: { workspaceRole: row.workspace_role, expiresAt: row.expires_at.toISOString() },
      })
      return row
    })
    reply.status(201)
    return {
      invite: {
        workspaceId: invite.workspace_id,
        id: invite.id,
        workspaceRole: invite.workspace_role,
        createdBy: invite.created_by,
        createdAt: invite.created_at.toISOString(),
        expiresAt: invite.expires_at.toISOString(),
      },
      token,
    }
  })
}
