import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_initial.ts'
import * as m0002 from './0002_item_index.ts'
import * as m0003 from './0003_auth_access.ts'

// Listed explicitly instead of read from disk, so migrations survive bundling into the image.
// Names sort in run order.
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_item_index': m0002,
  '0003_auth_access': m0003,
}
