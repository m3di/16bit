import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely'
import { Migrator } from 'kysely/migration'
import pg from 'pg'
import { migrations } from './migrations/index.ts'

// Row types for the tables. Column names are snake_case as in the database;
// the wire shapes in packages/core are camelCase and mapped at the edge.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type Json<T> = ColumnType<T, T | string, T | string>

type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer' | 'finance'
type PrincipalKind = 'user' | 'agent'

// Installation-level, outside row-level security (D46).
export interface AccountTable {
  id: string
  /** Trimmed and lowercased. */
  email: string
  /** argon2id PHC string. */
  password_hash: string
  name: string
  created_at: Timestamp
}

export interface SessionTable {
  id_hash: string
  account_id: string
  created_at: Timestamp
  last_seen_at: Timestamp
  expires_at: Timestamp
}

export interface WorkspaceTable {
  id: string
  name: string
  created_at: Timestamp
  next_revision_seq: Generated<number>
  next_access_seq: Generated<number>
}

export interface PrincipalTable {
  workspace_id: string
  id: string
  kind: PrincipalKind
  name: string
  workspace_role: WorkspaceRole
  /** Users only. Null for agents and for users created before M1. */
  account_id: Generated<string | null>
}

export interface InviteTable {
  workspace_id: string
  id: string
  token_hash: string
  workspace_role: WorkspaceRole
  created_by: string
  expires_at: Timestamp
  used_at: Timestamp | null
}

/** One key per agent principal; its hub and role are its single hub_grant (D47). */
export interface AgentKeyTable {
  workspace_id: string
  principal_id: string
  principal_kind: Generated<'agent'>
  secret_hash: string
  expires_at: Timestamp | null
  revoked_at: Timestamp | null
}

export interface HubGrantTable {
  workspace_id: string
  hub_id: string
  principal_id: string
  /** Must match principal.kind; defaults to 'user'. */
  principal_kind: Generated<PrincipalKind>
  hub_role: 'hub_admin' | 'editor' | 'commenter' | 'viewer'
}

export interface AccessLogTable {
  workspace_id: string
  seq: number
  actor: string
  action: string
  target: string
  detail: Json<Record<string, unknown>>
  at: Timestamp
}

export interface FolderTable {
  workspace_id: string
  id: string
  hub_id: string
  parent_id: string | null
  name: string
  color: string
  id_prefix: string
  item_count: Generated<number>
  version: Generated<number>
  next_seq: Generated<number>
}

export interface AttributeTable {
  workspace_id: string
  id: string
  hub_id: string
  name: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'select'
  config: Json<Record<string, unknown>>
  indexed: Generated<boolean>
}

export interface FolderAttributeTable {
  workspace_id: string
  hub_id: string
  folder_id: string
  attribute_id: string
  position: number
  required: Generated<boolean>
}

export interface ItemTable {
  workspace_id: string
  id: string
  hub_id: string
  folder_id: string
  seq_id: number
  values: Json<Record<string, string | number | boolean | null>>
  version: Generated<number>
  updated_at: Timestamp
  updated_by: string
}

export interface RevisionTable {
  workspace_id: string
  seq: number
  item_id: string
  version: number
  patch: Json<Record<string, unknown>>
  actor: string
  cause: string | null
  at: Timestamp
}

export interface Database {
  account: AccountTable
  session: SessionTable
  workspace: WorkspaceTable
  principal: PrincipalTable
  folder: FolderTable
  attribute: AttributeTable
  folder_attribute: FolderAttributeTable
  item: ItemTable
  revision: RevisionTable
  invite: InviteTable
  agent_key: AgentKeyTable
  hub_grant: HubGrantTable
  access_log: AccessLogTable
}

// bigint (int8) columns hold versions, counters, and sequence numbers, all far below 2^53.
const types = new pg.TypeOverrides()
types.setTypeParser(pg.types.builtins.INT8, Number)

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10, types }) }),
  })
}

/** Applies every pending migration. Throws if one fails; earlier ones stay applied. */
export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  })
  const { error, results = [] } = await migrator.migrateToLatest()
  if (error) {
    const failed = results.find((r) => r.status === 'Error')?.migrationName
    throw new Error(failed ? `migration ${failed} failed` : 'migrations did not run', {
      cause: error,
    })
  }
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName)
}
