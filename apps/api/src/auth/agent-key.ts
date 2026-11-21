import { createHash, randomBytes } from 'node:crypto'
import { agentHubRoleSchema, type AgentHubRole } from '@16bit/core'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/database.ts'

// Agent keys (D47): the bearer-token branch of the auth hook in `auth.ts`.

/** An agent key: one principal, one workspace, one hub. */
export interface AgentIdentity {
  kind: 'agent'
  principalId: string
  workspaceId: string
  workspaceName: string
  workspaceCreatedAt: Date
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
  return resolveAgentKeyHash(db, hashAgentSecret(token))
}

/** `resolveAgentKey` by the secret's hash, for the feed's periodic check of an open socket. */
export async function resolveAgentKeyHash(
  db: Kysely<Database>,
  secretHash: string,
): Promise<AgentIdentity | null> {
  const { rows } = await sql<{
    workspace_id: string
    workspace_name: string
    workspace_created_at: Date
    principal_id: string
    hub_id: string
    hub_name: string
    hub_role: string
  }>`SELECT * FROM auth_agent_key(${secretHash})`.execute(db)
  const row = rows[0]
  if (!row) return null
  return {
    kind: 'agent',
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceCreatedAt: row.workspace_created_at,
    hubId: row.hub_id,
    hubName: row.hub_name,
    hubRole: agentHubRoleSchema.parse(row.hub_role),
  }
}
