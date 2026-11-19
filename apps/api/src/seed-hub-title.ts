import { sql, type Transaction } from 'kysely'
import type { Database } from './db/database.ts'

/**
 * Names `attributeId` as the hub's title attribute (D50) for the seeds (#120), only on a hub that
 * nobody has edited: no title, and version 0. Every hub settings write bumps the version, so a
 * title a hub admin set, changed or cleared stays as they left it, and a re-run changes nothing.
 * A hub seeded before #120 and never edited gets its title, which bumps its version like any
 * write to a row clients have seen. A hub created in this transaction (`created`) gets it as part
 * of its creation and stays at version 0. Does nothing if the attribute is missing (deleted
 * through the API, #133) or not text.
 * Edge case: deleting the title attribute in SQL, not through the API, clears the title without a
 * version bump (FK `ON DELETE SET NULL`, migration 0009), so a re-run names the next text one.
 *
 * Lock order as `PATCH /hubs/:hubId` (migration 0009): the attribute FOR KEY SHARE, then the hub
 * row, so an attribute delete in the same hub can't deadlock with it.
 */
export async function seedHubTitle(
  trx: Transaction<Database>,
  workspaceId: string,
  hubId: string,
  attributeId: string,
  created: boolean,
): Promise<void> {
  const attribute = await trx
    .selectFrom('attribute')
    .select('type')
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where('id', '=', attributeId)
    .forKeyShare()
    .executeTakeFirst()
  if (attribute?.type !== 'text') return
  await trx
    .updateTable('folder')
    .set({
      title_attribute_id: attributeId,
      ...(!created && { version: sql<number>`version + 1` }),
    })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', hubId)
    .where('parent_id', 'is', null)
    .where('title_attribute_id', 'is', null)
    .where('version', '=', 0)
    .execute()
}
