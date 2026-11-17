import { fileURLToPath } from 'node:url'

// Kept apart from fixtures.ts so playwright.config.ts can import it without loading the test API.

/** The password of every person `pnpm seed` creates (apps/api/src/dev-accounts.ts). */
export const DEV_PASSWORD = '16bit-dev-password'

/**
 * The people `pnpm seed` creates in Pixel Works (`demo`), with their grants there (README.md).
 * `id` is their principal ID in that workspace.
 */
export const people = {
  owner: { id: 'dev-owner', email: 'owner@example.com', name: 'Dev Owner', role: 'owner' },
  /** Hub admin of Support, editor of Product and Launch, no grant on Design, Hiring, Archive. */
  mina: { id: 'mina', email: 'mina@example.com', name: 'Mina Park', role: 'admin' },
  /** Editor of Product and Launch, commenter on Support, viewer of Design. */
  leo: { id: 'leo', email: 'leo@example.com', name: 'Leo Varga', role: 'member' },
  /** Viewer of Product and Launch (her editor grant on Launch acts as viewer). */
  ivy: { id: 'ivy', email: 'ivy@example.com', name: 'Ivy Chen', role: 'viewer' },
  /** Viewer of Support. */
  noor: { id: 'noor', email: 'noor@example.com', name: 'Noor Haddad', role: 'finance' },
} as const

export type Person = keyof typeof people

/** Development password only. */
export const owner = { email: people.owner.email, password: DEV_PASSWORD } as const

/** The signed-in browser state `auth.setup.ts` saves for one person. Not in git. */
export function stateFile(person: Person): string {
  return fileURLToPath(new URL(`../../.auth/${person}.json`, import.meta.url))
}

export const OWNER_STATE = stateFile('owner')
