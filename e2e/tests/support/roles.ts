import {
  acceptedInviteSchema,
  createdAgentKeySchema,
  createdInviteSchema,
  itemSchema,
  MAX_PAGE_LIMIT,
  type AgentHubRole,
  type AgentKey,
  type Item,
  type Page as ListPage,
} from '@16bit/core'
import { readFileSync } from 'node:fs'
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type Page,
  type ViewportSize,
} from '@playwright/test'
import { people, stateFile, type Person } from './auth-state.ts'

// The role-matrix suite (#53, docs/ROLES.md). Each spec acts as the seeded people of Pixel
// Works, with a client per principal that returns raw responses, so a spec can check the exact
// status of a forbidden action as well as the page the same person sees.
//
// Specs never change a seeded person's role or grants. Anything a spec changes belongs to it:
// people it invites (removed again when the test ends), agent keys it creates (revoked when the
// test ends), hubs it creates, and items it creates.

export const WS = 'demo'
export const WS_NAME = 'Pixel Works'

/**
 * Contexts made inside a test take the project's `use` options, storage state included, so
 * without this every request and page would also carry the owner's session. That is wrong for
 * a key (D49 refuses both) and harmful for signing in or accepting an invite, which end the
 * session the request came with.
 */
export const NO_STATE = { cookies: [], origins: [] }

/** A raw API client for one principal: a session cookie, a bearer key, or nothing. */
export class Client {
  readonly #request: APIRequestContext

  constructor(request: APIRequestContext) {
    this.#request = request
  }

  /** `/v1/workspaces/demo` + `rest`, or `rest` itself when it starts with `/v1/`. */
  static path(rest: string): string {
    return rest.startsWith('/v1/') ? rest : `/v1/workspaces/${WS}${rest}`
  }

  get(path: string): Promise<APIResponse> {
    return this.#request.get(Client.path(path))
  }

  post(path: string, data: unknown = {}): Promise<APIResponse> {
    return this.#request.post(Client.path(path), { data })
  }

  put(path: string, data: unknown = {}): Promise<APIResponse> {
    return this.#request.put(Client.path(path), { data })
  }

  patch(path: string, data: unknown = {}): Promise<APIResponse> {
    return this.#request.patch(Client.path(path), { data })
  }

  delete(path: string): Promise<APIResponse> {
    return this.#request.delete(Client.path(path))
  }

  /** Creates an item and expects 201. */
  async createItem(folderId: string, values: Record<string, unknown>): Promise<Item> {
    const res = await this.post('/items', { folderId, values })
    await expectStatus(res, 201)
    return itemSchema.parse(await res.json())
  }

  dispose(): Promise<void> {
    return this.#request.dispose()
  }
}

/** Fails with the response body in the message, so a failure says what the API objected to. */
export async function expectStatus(res: APIResponse, status: number): Promise<void> {
  expect(res.status(), `${res.url()}: ${await res.text()}`).toBe(status)
}

/**
 * Every entry of a paged list (`/hubs`, `/members`, `/hubs/:id/agent-keys`, ...), following
 * `nextCursor` to the last page. A long-lived database holds more rows than one page (#158), so
 * a spec never looks for its own row in the first page only.
 */
export async function listAll<T>(
  client: Client,
  path: string,
  schema: { parse: (body: unknown) => ListPage<T> },
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  do {
    const sep = path.includes('?') ? '&' : '?'
    const after = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const res = await client.get(`${path}${sep}limit=${String(MAX_PAGE_LIMIT)}${after}`)
    await expectStatus(res, 200)
    const page = schema.parse(await res.json())
    all.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return all
}

/** A title no other test or run will use, so a spec can find exactly its own row. */
export function uniqueTitle(label: string): string {
  return `e2e ${label} ${crypto.randomUUID().slice(0, 8)}`
}

/**
 * A name for a hub a spec creates. Hubs can't be deleted in M1, so they sort after the seeded
 * ones on the dashboard and in the paged hub list, whatever the database's collation.
 */
export function uniqueHubName(label: string): string {
  return `Zz e2e ${label} ${crypto.randomUUID().slice(0, 8)}`
}

function sessionCookie(person: Person): string {
  const file = stateFile(person)
  const state = JSON.parse(readFileSync(file, 'utf8')) as {
    cookies: { name: string; value: string }[]
  }
  const sid = state.cookies.find((c) => c.name === 'sid')
  if (!sid) throw new Error(`No session cookie in ${file}; did auth.setup.ts run?`)
  return sid.value
}

/** Someone the spec invited: a fresh account and principal, removed when the test ends. */
export interface Invited {
  principalId: string
  email: string
  password: string
  name: string
  /** The session cookie value the invite's acceptance started. */
  sid: string
  client: Client
}

export interface CreatedKey {
  key: AgentKey
  secret: string
  client: Client
}

interface Fixtures {
  /** The API as a seeded person, signed in through auth.setup.ts. */
  as: (person: Person) => Client
  /** The API with no credentials at all. */
  anonymous: Client
  /** A bearer client for any secret. */
  bearer: (secret: string) => Promise<Client>
  /** A browser page signed in as a seeded person. */
  pageAs: (person: Person, viewport?: ViewportSize) => Promise<Page>
  /** A browser page carrying this session cookie, or none (`null`): for people a spec invited. */
  pageWithSession: (sid: string | null, viewport?: ViewportSize) => Promise<Page>
  /**
   * Invites someone through `by` (default the owner) and accepts as a new account. Removed at
   * the end. Never an owner: a second owner would let the seeded one step down in a parallel test.
   */
  invite: (
    workspaceRole: 'admin' | 'member' | 'viewer' | 'finance',
    options?: { by?: Client },
  ) => Promise<Invited>
  /**
   * Creates an agent key as `creator`: a seeded person (default the owner) or any client, such
   * as an invited person's. Revoked at the end, even if the test revoked it already.
   */
  agentKey: (input: {
    hubId: string
    hubRole: AgentHubRole
    creator?: Person | Client
    expiresAt?: string
  }) => Promise<CreatedKey>
}

async function newPage(
  browser: Browser,
  storageState: string | undefined,
  viewport: ViewportSize | undefined,
  opened: { close(): Promise<void> }[],
): Promise<Page> {
  const context = await browser.newContext({
    storageState: storageState ?? NO_STATE,
    ...(viewport ? { viewport } : {}),
  })
  opened.push(context)
  return context.newPage()
}

export const test = base.extend<Fixtures>({
  as: async ({ playwright, baseURL }, use) => {
    // One request context per seeded person, made up front so `as()` needs no await. Same
    // origin as the app, as in production (D34). The cookie goes as a header, so it also works
    // over plain HTTP.
    const contexts = new Map<Person, APIRequestContext>()
    for (const person of Object.keys(people) as Person[]) {
      contexts.set(
        person,
        await playwright.request.newContext({
          storageState: NO_STATE,
          baseURL,
          extraHTTPHeaders: { Cookie: `sid=${sessionCookie(person)}` },
        }),
      )
    }
    const clients = new Map([...contexts].map(([p, c]) => [p, new Client(c)]))
    await use((person) => clients.get(person) as Client)
    await Promise.all([...contexts.values()].map((c) => c.dispose()))
  },

  anonymous: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL, storageState: NO_STATE })
    await use(new Client(request))
    await request.dispose()
  },

  bearer: async ({ playwright, baseURL }, use) => {
    const contexts: APIRequestContext[] = []
    await use(async (secret) => {
      // No cookie: a request with both a session and a key is refused (D49).
      const request = await playwright.request.newContext({
        storageState: NO_STATE,
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
      })
      contexts.push(request)
      return new Client(request)
    })
    await Promise.all(contexts.map((c) => c.dispose()))
  },

  pageAs: async ({ browser }, use) => {
    const opened: { close(): Promise<void> }[] = []
    await use((person, viewport) => newPage(browser, stateFile(person), viewport, opened))
    await Promise.all(opened.map((c) => c.close()))
  },

  pageWithSession: async ({ browser, baseURL }, use) => {
    const opened: { close(): Promise<void> }[] = []
    await use(async (sid, viewport) => {
      const page = await newPage(browser, undefined, viewport, opened)
      if (sid !== null && baseURL) {
        await page.context().addCookies([{ name: 'sid', value: sid, url: baseURL, httpOnly: true }])
      }
      return page
    })
    await Promise.all(opened.map((c) => c.close()))
  },

  invite: async ({ as, playwright, baseURL }, use) => {
    const invited: Invited[] = []
    const contexts: APIRequestContext[] = []
    await use(async (workspaceRole, { by = as('owner') } = {}) => {
      const created = await by.post('/invites', { workspaceRole })
      await expectStatus(created, 201)
      const { token } = createdInviteSchema.parse(await created.json())

      const tag = crypto.randomUUID().slice(0, 8)
      const person = {
        name: `E2E ${workspaceRole} ${tag}`,
        email: `e2e-${tag}@example.com`,
        password: `e2e-password-${crypto.randomUUID()}`,
      }
      const fresh = await playwright.request.newContext({ baseURL, storageState: NO_STATE })
      const accepted = await fresh.post(`/v1/auth/invites/${token}`, { data: person })
      await expectStatus(accepted, 201)
      const { principalId } = acceptedInviteSchema.parse(await accepted.json())
      const sid = /(?:^|\n)sid=([^;]+)/.exec(
        accepted
          .headersArray()
          .filter((h) => h.name.toLowerCase() === 'set-cookie')
          .map((h) => h.value)
          .join('\n'),
      )?.[1]
      await fresh.dispose()
      if (!sid) throw new Error('Accepting the invite set no session cookie')

      const request = await playwright.request.newContext({
        storageState: NO_STATE,
        baseURL,
        extraHTTPHeaders: { Cookie: `sid=${sid}` },
      })
      contexts.push(request)
      const entry = { ...person, principalId, sid, client: new Client(request) }
      invited.push(entry)
      return entry
    })
    // Removing them revokes their grants in this workspace, so nothing they held outlives
    // the test (docs/ROLES.md). A test that removed them itself gets a 404 here.
    for (const p of invited) {
      const res = await as('owner').delete(`/members/${encodeURIComponent(p.principalId)}`)
      expect([204, 404]).toContain(res.status())
    }
    await Promise.all(contexts.map((c) => c.dispose()))
  },

  agentKey: async ({ as, bearer }, use) => {
    const keys: string[] = []
    await use(async ({ hubId, hubRole, creator = 'owner', expiresAt }) => {
      const client = typeof creator === 'string' ? as(creator) : creator
      const res = await client.post(`/hubs/${hubId}/agent-keys`, {
        name: `E2E key ${crypto.randomUUID().slice(0, 8)}`,
        hubRole,
        ...(expiresAt ? { expiresAt } : {}),
      })
      await expectStatus(res, 201)
      const created = createdAgentKeySchema.parse(await res.json())
      keys.push(created.key.id)
      return { ...created, client: await bearer(created.secret) }
    })
    // Revoking a revoked or expired key is a no-op that still answers 200.
    for (const id of keys) {
      await expectStatus(
        await as('owner').post(`/agent-keys/${encodeURIComponent(id)}/revoke`),
        200,
      )
    }
  },
})

/** The page's table of items in a folder. */
export function itemsTable(page: Page, folderName: string) {
  return page.getByRole('table', { name: `Items in ${folderName}` })
}

/** The item panel. */
export function itemPanel(page: Page) {
  return page.getByRole('complementary', { name: 'Item', exact: true })
}

/** A workspace's section on the dashboard. */
export function workspaceSection(page: Page, name: string = WS_NAME) {
  return page.getByRole('region', { name })
}

export function hubPath(hubId: string): string {
  return `/w/${WS}/hubs/${hubId}`
}

export { expect, people }
