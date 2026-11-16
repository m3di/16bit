import { createHash, randomBytes } from 'node:crypto'
import { agentHubRoleSchema, can, type AgentHubRole, type Subject } from '@16bit/core'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/database.ts'
import { enforce } from '../http.ts'
import type { Identity } from './auth.ts'

// Agent keys (D47): the bearer-token branch of the auth hook in `auth.ts`.

/** An agent key: one principal, one workspace, one hub. */
export interface AgentIdentity {
  kind: 'agent'
  principalId: string
  workspaceId: string
  workspaceName: string
  hubId: string
  hubName: string
  hubRole: AgentHubRole
}

/** Agent secrets carry a prefix so a leaked one is easy to recognise and scan for. */
export const AGENT_SECRET_PREFIX = '16b_'

/** 256 random bits. High entropy, so a fast hash is enough to store it (unlike passwords). */
export const newAgentSecret = () => `${AGENT_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`

/** What `agent_key.secret_hash` holds: hex SHA-256 of the whole secret. */
export const hashAgentSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

/**
 * The agent behind a bearer token, or null. Goes through the SECURITY DEFINER lookup, so it
 * keeps working under row-level security. Revoked and expired keys return no row.
 */
export async function resolveAgentKey(
  db: Kysely<Database>,
  token: string,
): Promise<AgentIdentity | null> {
  if (!token.startsWith(AGENT_SECRET_PREFIX)) return null
  const { rows } = await sql<{
    workspace_id: string
    workspace_name: string
    principal_id: string
    hub_id: string
    hub_name: string
    hub_role: string
  }>`SELECT * FROM auth_agent_key(${hashAgentSecret(token)})`.execute(db)
  const row = rows[0]
  if (!row) return null
  return {
    kind: 'agent',
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    hubId: row.hub_id,
    hubName: row.hub_name,
    hubRole: agentHubRoleSchema.parse(row.hub_role),
  }
}

/**
 * Holds an agent key to its one hub and role on the item routes. People are not checked
 * here yet: #43 puts every route, for every principal, behind `can()` and hub grants.
 * `what` names the thing in the 404, so a hidden hub looks the same as a missing one.
 */
export function agentHubCheck(
  identity: Identity | null,
  principal: Subject,
  hubId: string,
  action: 'hub.read' | 'item.write',
  what: string,
): void {
  if (identity?.kind !== 'agent') return
  const hubGrant = hubId === identity.hubId ? identity.hubRole : null
  enforce(can(principal, action, { hubGrant }), what)
}
