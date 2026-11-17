import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_initial.ts'
import * as m0002 from './0002_item_index.ts'
import * as m0003 from './0003_auth_access.ts'
import * as m0004 from './0004_auth_functions.ts'
import * as m0005 from './0005_agent_key_lookup.ts'
import * as m0006 from './0006_link.ts'
import * as m0007 from './0007_principal_removed.ts'
import * as m0008 from './0008_row_level_security.ts'

// Listed explicitly instead of read from disk, so migrations survive bundling into the image.
// Names sort in run order.
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_item_index': m0002,
  '0003_auth_access': m0003,
  '0004_auth_functions': m0004,
  '0005_agent_key_lookup': m0005,
  '0006_link': m0006,
  '0007_principal_removed': m0007,
  '0008_row_level_security': m0008,
}
