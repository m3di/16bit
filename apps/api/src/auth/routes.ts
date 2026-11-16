import { randomUUID } from 'node:crypto'
import {
  acceptInviteSchema,
  can,
  createInviteSchema,
  inviteTokenSchema,
  loginRequestSchema,
  MAX_ME_MEMBERSHIPS,
  type AcceptedInvite,
  type CreatedInvite,
  type Me,
} from '@16bit/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { appendAccessLog } from '../access-log.ts'
import type { Database } from '../db/database.ts'
import { HttpError, parse } from '../http.ts'
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
}

const optional = { config: { auth: 'optional' as const } }
const tokenParams = z.object({ token: inviteTokenSchema })
const workspaceParams = z.object({ workspaceId: z.string() })

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

    const account = await db
      .selectFrom('account')
      .select(['id', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst()
    const ok = account
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
    if (identity.kind !== 'person') {
      throw new HttpError('unauthorized', 'The development key has no account. Sign in.')
    }
    return me(db, identity.accountId)
  })

  v1.post('/auth/invites/:token', optional, async (request, reply) => {
    const wait = options.ipLimiter.hit(request.ip)
    if (wait) return tooMany(reply, wait)
    const { token } = parse(tokenParams, request.params)
    const body = parse(acceptInviteSchema, request.body)
    const tokenHash = hashToken(token)
    const signedIn = request.identity?.kind === 'person' ? request.identity : undefined

    let accountId: string
    let redeemed: AcceptedInvite
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
  ws.post('/invites', async (request, reply): Promise<CreatedInvite> => {
    const { workspaceId } = parse(workspaceParams, request.params)
    const input = parse(createInviteSchema, request.body)
    if (can(request.principal, 'member.invite', { role: input.workspaceRole }) !== 'allow') {
      throw new HttpError('forbidden', 'Your role cannot create this invite')
    }
    const token = newToken()
    const invite = await db.transaction().execute(async (trx) => {
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
