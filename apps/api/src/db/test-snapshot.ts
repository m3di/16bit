import type { Kysely } from 'kysely'
import type { Database } from './database.ts'

// Test helper. Every row of one workspace that the item write paths can touch. Taken before and
// after a write elsewhere and compared, it proves the write stayed inside its own workspace.

export async function workspaceSnapshot(db: Kysely<Database>, workspaceId: string) {
  return {
    workspace: await db.selectFrom('workspace').selectAll().where('id', '=', workspaceId).execute(),
    folders: await db
      .selectFrom('folder')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('id')
      .execute(),
    items: await db
      .selectFrom('item')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('id')
      .execute(),
    itemIndex: await db
      .selectFrom('item_index')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('item_id')
      .orderBy('attribute_id')
      .orderBy('ord')
      .execute(),
    revisions: await db
      .selectFrom('revision')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('seq')
      .execute(),
  }
}
