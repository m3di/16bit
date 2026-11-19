import type { AttributeTypeName, ItemValues } from '@16bit/core'
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
  /** Users only. Null for agents, for users created before M1, and for removed members. */
  account_id: Generated<string | null>
  /** Set when the member was removed (#43). A removed principal acts nowhere. */
  removed_at: Generated<Timestamp | null>
}

export interface InviteTable {
  workspace_id: string
  id: string
  token_hash: string
  workspace_role: WorkspaceRole
  created_by: string
  created_at: Timestamp
  expires_at: Timestamp
  used_at: Timestamp | null
}

/** One key per agent principal; its hub and role are its single hub_grant (D47). */
export interface AgentKeyTable {
  workspace_id: string
  principal_id: string
  principal_kind: Generated<'agent'>
  secret_hash: string
  created_by: string
  created_at: Timestamp
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
  title_attribute_id: Generated<string | null>
}

export interface AttributeTable {
  workspace_id: string
  id: string
  hub_id: string
  name: string
  type: AttributeTypeName
  config: Json<Record<string, unknown>>
  indexed: Generated<boolean>
  version: Generated<number>
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
  values: Json<ItemValues>
  version: Generated<number>
  updated_at: Timestamp
  updated_by: string
}

/** Derived typed copies of indexed values (D6). Exactly one of num, txt, ts is set. */
export interface ItemIndexTable {
  workspace_id: string
  attribute_id: string
  item_id: string
  ord: Generated<number>
  num: number | null
  txt: string | null
  ts: ColumnType<Date | null, Date | string | null, Date | string | null>
}

/** One row per item a relation value links to (D7). Kept in step with item.values. */
export interface LinkTable {
  workspace_id: string
  from_item: string
  attribute_id: string
  to_item: string
}

export interface RevisionTable {
  workspace_id: string
  seq: number
  item_id: string
  /** The item's hub, kept after the item is deleted, for row-level security (#44). */
  hub_id: string
  version: number
  patch: Json<Record<string, unknown>>
  actor: string
  cause: string | null
  at: Timestamp
}

/** IDs of deleted hubs (D52, #111). Written by delete_hub() only; the API role can't read it. */
export interface DeletedHubTable {
  workspace_id: string
  id: string
  deleted_at: Generated<Timestamp>
  deleted_by: string
}

export interface DeletedAttributeTable {
  workspace_id: string
  id: string
  hub_id: string
  deleted_at: Generated<Timestamp>
  deleted_by: string | null
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
  item_index: ItemIndexTable
  link: LinkTable
  revision: RevisionTable
  invite: InviteTable
  agent_key: AgentKeyTable
  hub_grant: HubGrantTable
  access_log: AccessLogTable
  deleted_hub: DeletedHubTable
  deleted_attribute: DeletedAttributeTable
}

// bigint (int8) columns hold versions, counters, and sequence numbers, all far below 2^53.
const types = new pg.TypeOverrides()
types.setTypeParser(pg.types.builtins.INT8, Number)

/**
 * A pool whose `end()` resolves only once every client's socket has closed (#103). pg-pool's own
 * `end()` resolves as soon as it has asked its idle clients to end, before their sockets close,
 * so a server-side termination in that window (`DROP DATABASE ... WITH (FORCE)` in tests) reached
 * a client with no one listening and crashed the process. This covers shutdown only. A pooled
 * client terminated at any other time (a Postgres restart, `pg_terminate_backend`, a network drop)
 * is reported as the pool's `error` event, which `createDb` listens to (#107).
 */
export class ClosingPool extends pg.Pool {
  readonly #open = new Set<pg.PoolClient>()

  constructor(config: pg.PoolConfig) {
    super(config)
    this.on('connect', (client) => {
      this.#open.add(client)
      // A checked-out client has no pg-pool listener, so a socket error mid-query (ECONNRESET)
      // would be uncaught. The query already rejects with it and the pool discards the client on
      // release; idle drops are logged by the pool's own `error` listener in createDb (#107).
      client.on('error', () => {})
      client.once('end', () => this.#open.delete(client))
    })
  }

  override async end(): Promise<void> {
    await super.end()
    await Promise.all(
      [...this.#open].map((client) => new Promise<void>((done) => client.once('end', done))),
    )
  }
}

function logPoolError(error: Error): void {
  const code = (error as { code?: unknown }).code
  console.error(
    `db: pooled connection lost${typeof code === 'string' ? ` (${code})` : ''}, discarded: ${error.message}`,
  )
}

/**
 * The pool emits `error` when Postgres drops a connection it holds (a restart,
 * `pg_terminate_backend`, a network drop). pg-pool has already discarded that client, and the next
 * query opens a new one; without a listener the event would crash the process (#107). A query in
 * flight on a dropped connection still rejects as usual. After Postgres terminates a query in
 * flight, the next query can still fail once on the dying connection before the pool drops it.
 */
export function createDb(connectionString: string): Kysely<Database> {
  const pool = new ClosingPool({ connectionString, max: 10, types })
  pool.on('error', logPoolError)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
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
