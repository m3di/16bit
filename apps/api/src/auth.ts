import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { agentHubRoleSchema, can, type AgentHubRole, type Subject } from '@16bit/core'
import { sql, type Kysely } from 'kysely'
import type { Database } from './db/database.ts'
import { enforce, HttpError, notFound } from './http.ts'

// Request authentication. `authenticate` runs once per request and says who is calling;
// `workspaceActor` then turns that into the `can()` subject for the workspace in the path.
// M1-03 (#41) adds the session-cookie branch to both.

/** Who sent the request, before a workspace is known. */
export type Identity =
  /** The development bearer key (M0), acting as a configured principal in any workspace. */
  | { kind: 'dev'; principalId: string }
  /** An agent key (D47): one principal, one workspace, one hub. */
  | {
      kind: 'agent'
      workspaceId: string
      principalId: string
      hubId: string
      hubRole: AgentHubRole
    }

/** Agent secrets carry a prefix so a leaked one is easy to recognise and scan for. */
export const AGENT_SECRET_PREFIX = '16b_'

/** 256 random bits. High entropy, so a fast hash is enough to store it (unlike passwords). */
export const newAgentSecret = () => `${AGENT_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`

/** What `agent_key.secret_hash` holds: hex SHA-256 of the whole secret. */
export const hashAgentSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

const digest = (value: string) => createHash('sha256').update(value).digest()

export interface AuthOptions {
  devApiKey: string
  devPrincipalId: string
  anonymousAsDevPrincipal?: boolean | undefined
}

export function authenticator(db: Kysely<Database>, options: AuthOptions) {
  const devKey = digest(options.devApiKey)
  const dev: Identity = { kind: 'dev', principalId: options.devPrincipalId }

  return async (authorization: string | undefined): Promise<Identity> => {
    if (options.anonymousAsDevPrincipal && authorization === undefined) return dev
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
    if (!token) throw unauthorized()
    if (timingSafeEqual(digest(token), devKey)) return dev
    if (!token.startsWith(AGENT_SECRET_PREFIX)) throw unauthorized()

    // Through the SECURITY DEFINER lookup, so it keeps working under row-level security.
    // Revoked and expired keys return no row.
    const { rows } = await sql<{
      workspace_id: string
      principal_id: string
      hub_id: string
      hub_role: string
    }>`SELECT * FROM auth_agent_key(${hashAgentSecret(token)})`.execute(db)
    const row = rows[0]
    if (!row) throw unauthorized()
    return {
      kind: 'agent',
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      hubId: row.hub_id,
      hubRole: agentHubRoleSchema.parse(row.hub_role),
    }
  }
}

const unauthorized = () => new HttpError('unauthorized', 'A valid bearer token is required')

/**
 * The caller as a `can()` subject in `workspaceId`. A workspace the caller is not a principal
 * of does not exist for them (404). An agent only exists in its key's workspace.
 */
export async function workspaceActor(
  db: Kysely<Database>,
  identity: Identity,
  workspaceId: string,
): Promise<Subject> {
  if (identity.kind === 'agent') {
    if (identity.workspaceId !== workspaceId) throw notFound('Workspace')
    return { id: identity.principalId, kind: 'agent', workspaceRole: 'member' }
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

/**
 * Holds an agent key to its one hub and role on the item routes. People are not checked
 * here yet: M1-05 (#43) puts every route, for every principal, behind `can()` and hub grants.
 * `what` names the thing in the 404, so a hidden hub looks the same as a missing one.
 */
export function agentHubCheck(
  identity: Identity,
  principal: Subject,
  hubId: string,
  action: 'hub.read' | 'item.write',
  what: string,
): void {
  if (identity.kind !== 'agent') return
  const hubGrant = hubId === identity.hubId ? identity.hubRole : null
  enforce(can(principal, action, { hubGrant }), what)
}
