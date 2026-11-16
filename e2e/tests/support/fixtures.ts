import { conflictErrorSchema, itemSchema, type ConflictError, type Item } from '@16bit/core'
import { test as base, expect, type APIRequestContext, type APIResponse } from '@playwright/test'

// Seeded by `pnpm seed` (apps/api/src/demo-seed.ts). Specs read these but never change them;
// anything a spec writes is a new item it creates for itself.
export const demo = {
  workspaceId: 'demo',
  workspaceName: 'Pixel Works',
  /** Specs create their items here, so the other seeded hubs keep their counts. */
  hub: {
    id: 'design',
    name: 'Design',
    titleAttributeId: 'design-title',
    stageAttributeId: 'design-stage',
  },
} as const

/** The items API, as the dev principal. Only what the specs need. */
export class Api {
  readonly #request: APIRequestContext

  constructor(request: APIRequestContext) {
    this.#request = request
  }

  private path(workspaceId: string, rest: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}${rest}`
  }

  async createItem(input: {
    workspaceId?: string
    folderId?: string
    values: Record<string, unknown>
  }): Promise<Item> {
    const res = await this.#request.post(
      this.path(input.workspaceId ?? demo.workspaceId, '/items'),
      {
        data: { folderId: input.folderId ?? demo.hub.id, values: input.values },
      },
    )
    await expectStatus(res, 201)
    return itemSchema.parse(await res.json())
  }

  async getItem(id: string, workspaceId: string = demo.workspaceId): Promise<Item> {
    const res = await this.#request.get(this.path(workspaceId, `/items/${encodeURIComponent(id)}`))
    await expectStatus(res, 200)
    return itemSchema.parse(await res.json())
  }

  /** Sends the PATCH and returns the raw response, so a spec can check a 409. */
  patchItem(
    item: Pick<Item, 'id' | 'workspaceId'>,
    body: { version: number; values: Record<string, unknown> },
  ): Promise<APIResponse> {
    return this.#request.patch(
      this.path(item.workspaceId, `/items/${encodeURIComponent(item.id)}`),
      {
        data: body,
      },
    )
  }

  async parseItem(res: APIResponse): Promise<Item> {
    await expectStatus(res, 200)
    return itemSchema.parse(await res.json())
  }

  async parseConflict(res: APIResponse): Promise<ConflictError> {
    await expectStatus(res, 409)
    return conflictErrorSchema.parse(await res.json())
  }
}

async function expectStatus(res: APIResponse, status: number): Promise<void> {
  // The body is in the message, so a failure says what the API objected to.
  expect(res.status(), `${res.url()}: ${await res.text()}`).toBe(status)
}

/** A title no other test or run will use, so a spec can find exactly its own row. */
export function uniqueTitle(label: string): string {
  return `e2e ${label} ${crypto.randomUUID().slice(0, 8)}`
}

export const test = base.extend<{ api: Api }>({
  api: async ({ playwright, baseURL }, use) => {
    // Same origin as the app, as in production (D34). The dev server's proxy would add the
    // key on its own, but sending it keeps the fixture working against any deployment.
    const key = process.env['DEV_API_KEY']
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: key ? { Authorization: `Bearer ${key}` } : {},
    })
    await use(new Api(request))
    await request.dispose()
  },
})

export { expect }
