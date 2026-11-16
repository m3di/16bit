import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely'
import { Migrator } from 'kysely/migration'
import pg from 'pg'
import { migrations } from './migrations/index.ts'

// Row types for the tables. Column names are snake_case as in the database;
// the wire shapes in packages/core are camelCase and mapped at the edge.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type Json<T> = ColumnType<T, T | string, T | string>

export interface WorkspaceTable {
  id: string
  name: string
  created_at: Timestamp
  next_revision_seq: Generated<number>
}

export interface PrincipalTable {
  workspace_id: string
  id: string
  kind: 'user' | 'agent'
  name: string
  workspace_role: 'owner' | 'admin' | 'member' | 'viewer' | 'finance'
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
  workspace: WorkspaceTable
  principal: PrincipalTable
  folder: FolderTable
  attribute: AttributeTable
  folder_attribute: FolderAttributeTable
  item: ItemTable
  item_index: ItemIndexTable
  revision: RevisionTable
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
