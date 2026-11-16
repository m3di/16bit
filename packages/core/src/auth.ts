import { z } from 'zod'
import { idSchema, timestampSchema, WORKSPACE_ROLES } from './entities.ts'
import { agentHubRoleSchema } from './roles.ts'

// Sign-in, sessions and invites (D42, D43, D46). These routes are installation-level:
// `/v1/auth/*` and `/v1/me` are not under a workspace. Creating an invite is.
//
// People sign in with email and password and get an httpOnly session cookie. Cookie-
// authenticated writes must come from the same origin (the API checks the browser's
// `Sec-Fetch-Site` or `Origin`); a browser `fetch` from the dashboard does this by itself.

/** Stored trimmed and lowercased, so the sign-in form may send any case. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254))

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256
/** For a new password. Sign-in only checks the upper bound, so old passwords keep working. */
export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH)

export const accountNameSchema = z.string().trim().min(1).max(200)

/** `POST /v1/auth/login`. A wrong email and a wrong password get the same 401. */
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})
export type LoginRequest = z.input<typeof loginRequestSchema>

/** An installation-level account (D46). One per person, across workspaces. */
export const accountSchema = z.strictObject({
  id: idSchema,
  email: z.string(),
  name: z.string(),
})
export type Account = z.infer<typeof accountSchema>

/** One workspace an account belongs to, as the principal it acts as there. */
export const membershipSchema = z.strictObject({
  workspace: z.strictObject({ id: idSchema, name: z.string() }),
  principalId: idSchema,
  workspaceRole: z.enum(WORKSPACE_ROLES),
})
export type Membership = z.infer<typeof membershipSchema>

/** At most this many memberships come back from `/v1/me`; `GET /v1/workspaces` pages. */
export const MAX_ME_MEMBERSHIPS = 200

/**
 * `GET /v1/me`, and the body of a successful `POST /v1/auth/login`.
 * A person gets their account and workspaces. An agent key gets its one workspace and hub
 * (D47). 401 without a session or key.
 */
export const meSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('person'),
    account: accountSchema,
    memberships: z.array(membershipSchema),
    /** `true` if the account has more than `MAX_ME_MEMBERSHIPS` workspaces. */
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    principalId: idSchema,
    workspace: z.strictObject({ id: idSchema, name: z.string() }),
    hub: z.strictObject({ id: idSchema, name: z.string() }),
    hubRole: agentHubRoleSchema,
  }),
])
export type Me = z.infer<typeof meSchema>

export const INVITE_DEFAULT_DAYS = 7
export const INVITE_MAX_DAYS = 30

/** `POST /v1/workspaces/:workspaceId/invites`. Owners and admins; admins can't invite owners. */
export const createInviteSchema = z.strictObject({
  workspaceRole: z.enum(WORKSPACE_ROLES),
  expiresInDays: z.int().min(1).max(INVITE_MAX_DAYS).default(INVITE_DEFAULT_DAYS),
})
export type CreateInvite = z.input<typeof createInviteSchema>

export const inviteSchema = z.strictObject({
  workspaceId: idSchema,
  id: idSchema,
  workspaceRole: z.enum(WORKSPACE_ROLES),
  createdBy: idSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
})
export type Invite = z.infer<typeof inviteSchema>

/** 201 from creating an invite. `token` is shown once and only its hash is stored. */
export const createdInviteSchema = z.strictObject({
  invite: inviteSchema,
  token: z.string(),
})
export type CreatedInvite = z.infer<typeof createdInviteSchema>

/** The invite token in `/v1/auth/invites/:token`. */
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/)

/**
 * `POST /v1/auth/invites/:token`. Either the fields of a new account, which is then signed
 * in, or `{}` to add the signed-in account. An unknown, used or expired invite is a 404.
 */
export const acceptInviteSchema = z.union([
  z.strictObject({
    name: accountNameSchema,
    email: emailSchema,
    password: newPasswordSchema,
  }),
  z.strictObject({}),
])
export type AcceptInvite = z.input<typeof acceptInviteSchema>

/** 201 from accepting an invite: where the account now belongs. */
export const acceptedInviteSchema = z.strictObject({
  workspaceId: idSchema,
  principalId: idSchema,
})
export type AcceptedInvite = z.infer<typeof acceptedInviteSchema>
