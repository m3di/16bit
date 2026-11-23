import { sql, type Kysely } from 'kysely'
import type { Database } from './db/database.ts'

// Planner statistics after a seed (#306). Migration 0017 runs ANALYZE while `item` and
// `item_index` are still empty, so on a fresh database the planner believes they hold almost
// nothing until autovacuum analyzes them again, a minute or more later. Reads right after a seed
// of thousands of items were then planned as nested loops (1 row estimated for a 2,000-item
// folder) costing seconds per view-data block. Runs as the owner of the tables, as the seeds do.

/** The tables item writes fill. ANALYZE samples, so this stays well under a second. */
const SEEDED_TABLES = ['item', 'item_index', 'link', 'revision'] as const

export async function analyzeSeeded(db: Kysely<Database>): Promise<void> {
  await sql.raw(`ANALYZE ${SEEDED_TABLES.join(', ')}`).execute(db)
}
