import {
  apiErrorSchema,
  MAX_PAGE_LIMIT,
  type ApiError,
  type ApiErrorCode,
  type Page,
} from '@16bit/core'

/** Anything with a zod-style `parse`. Responses are checked against the `@16bit/core` schemas. */
export interface Schema<T> {
  parse(data: unknown): T
}

export type Fetch = typeof fetch

/** `network`: no response. `bad_response`: a response that does not match the contract. */
export type RequestErrorCode = ApiErrorCode | 'network' | 'bad_response'

export class ApiRequestError extends Error {
  readonly code: RequestErrorCode
  /** HTTP status, or 0 when there was no response. */
  readonly status: number
  /** The full error body, for codes that add fields (`current` on a conflict). */
  readonly body: ApiError | null

  constructor(code: RequestErrorCode, message: string, status = 0, body: ApiError | null = null) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
    this.body = body
  }

  /**
   * The caller may not do this: `forbidden` (403). A 401 counts too, so a view shows a quiet
   * state for the moment before the unauthorized handler moves the reader to sign-in.
   */
  get isNoPermission(): boolean {
    return this.status === 401 || this.status === 403
  }

  /** No session, or it ended. The unauthorized handler sends the reader to sign-in. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /** `not_found` (404). Also what the API answers for things the caller holds no grant on. */
  get isNotFound(): boolean {
    return this.status === 404
  }
}

export interface RequestOptions {
  /**
   * Handle a 401 here instead of calling the unauthorized handler. For sign-in, `/v1/me`, and
   * invite acceptance, where a 401 is an answer, not an ended session.
   */
  quiet401?: boolean
}

let unauthorizedHandler: (() => void) | null = null

/** Called on every 401 not marked `quiet401`. Returns a function that removes the handler. */
export function setUnauthorizedHandler(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

/** For responses without a body, such as a 204. */
export const noContent: Schema<undefined> = { parse: () => undefined }

/** Stops a misbehaving cursor from looping forever: 50 pages of 200 is 10,000 entries. */
export const MAX_PAGES = 50

/** GETs `path` (same origin, `/v1/...`) and checks the body against `schema`. */
export function getJson<T>(
  path: string,
  schema: Schema<T>,
  fetchFn: Fetch = fetch,
  options: RequestOptions = {},
) {
  return requestJson('GET', path, undefined, schema, fetchFn, options)
}

/** POSTs or PATCHes `body` as JSON to `path` and checks the response against `schema`. */
export function sendJson<T>(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  schema: Schema<T>,
  fetchFn: Fetch = fetch,
  options: RequestOptions = {},
) {
  return requestJson(method, path, body, schema, fetchFn, options)
}

async function requestJson<T>(
  method: string,
  path: string,
  payload: unknown,
  schema: Schema<T>,
  fetchFn: Fetch,
  options: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const init: RequestInit = { method, headers }
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(payload)
  }

  let response: Response
  try {
    response = await fetchFn(path, init)
  } catch {
    throw new ApiRequestError('network', 'The server could not be reached.')
  }

  const body: unknown = await response.json().catch(() => undefined)

  if (!response.ok) {
    if (response.status === 401 && !options.quiet401) unauthorizedHandler?.()
    const error = apiErrorSchema.safeParse(body)
    if (error.success)
      throw new ApiRequestError(error.data.error, error.data.message, response.status, error.data)
    throw new ApiRequestError(
      'internal',
      `The server answered ${String(response.status)}.`,
      response.status,
    )
  }

  try {
    return schema.parse(body)
  } catch {
    throw new ApiRequestError(
      'bad_response',
      'The server sent an unexpected response.',
      response.status,
    )
  }
}

/** GETs every page of a list endpoint by following `nextCursor`. `path` may carry a query. */
export async function getAllPages<T>(
  path: string,
  pageSchema: Schema<Page<T>>,
  fetchFn: Fetch = fetch,
): Promise<T[]> {
  const split = path.indexOf('?')
  const base = split === -1 ? path : path.slice(0, split)
  const query = new URLSearchParams(split === -1 ? '' : path.slice(split + 1))
  if (!query.has('limit')) query.set('limit', String(MAX_PAGE_LIMIT))
  const entries: T[] = []
  let cursor: string | null = null
  for (let n = 0; n < MAX_PAGES; n++) {
    if (cursor) query.set('cursor', cursor)
    const page: Page<T> = await getJson(`${base}?${query.toString()}`, pageSchema, fetchFn)
    entries.push(...page.items)
    cursor = page.nextCursor
    if (!cursor) return entries
  }
  throw new ApiRequestError('bad_response', 'The list did not end.')
}

/** Normalises anything thrown into an `ApiRequestError`. */
export const asRequestError = (error: unknown) =>
  error instanceof ApiRequestError
    ? error
    : new ApiRequestError('internal', error instanceof Error ? error.message : 'Unknown error')
