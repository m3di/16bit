import type { Kysely } from 'kysely'
import type { Database } from './db/database.ts'

/**
 * Which of `ids` were deleted hubs or attributes (#133). The seeds skip them, so a re-run never
 * tries to bring one back (`hub_id_check` and `attribute_id_check` would refuse it with 23505).
 * Bounded by the seed definition. Read as the owner: the API role can't read the tombstones.
 */
export async function tombstoned(
  db: Kysely<Database>,
  table: 'deleted_hub' | 'deleted_attribute',
  workspaceId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db
    .selectFrom(table)
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', ids)
    .execute()
  return new Set(rows.map((r) => r.id))
}
