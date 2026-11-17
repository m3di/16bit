import { fileURLToPath } from 'node:url'

// Kept apart from fixtures.ts so playwright.config.ts can import it without loading the test API.

/** A person `pnpm seed` creates (apps/api/src/dev-accounts.ts). Development password only. */
export const owner = { email: 'owner@example.com', password: '16bit-dev-password' } as const

/** The signed-in browser state `auth.setup.ts` saves. Not in git. */
export const OWNER_STATE = fileURLToPath(new URL('../../.auth/owner.json', import.meta.url))
