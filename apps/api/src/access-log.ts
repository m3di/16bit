import { sql, type Transaction } from 'kysely'
import type { Database } from './db/database.ts'

/**
 * Appends to `access_log` (D48), taking `seq` from `workspace.next_access_seq`. Call it in the
 * same transaction as the access change; the row lock on the workspace orders concurrent ones.
 */
export async function appendAccessLog(
  trx: Transaction<Database>,
  entry: {
    workspaceId: string
    actor: string
    action: string
    target: string
    detail?: Record<string, unknown>
  },
): Promise<number> {
  const { seq } = await trx
    .updateTable('workspace')
    .set({ next_access_seq: sql`next_access_seq + 1` })
    .where('id', '=', entry.workspaceId)
    .returning(sql<number>`next_access_seq - 1`.as('seq'))
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('access_log')
    .values({
      workspace_id: entry.workspaceId,
      seq,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute()
  return seq
}
