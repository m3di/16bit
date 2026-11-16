import type { ApiErrorCode, Item } from '@16bit/core'
import { z } from 'zod'

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  invalid_values: 422,
  conflict: 409,
  id_taken: 409,
  internal: 500,
}

/** Thrown by handlers; the app's error handler turns it into the shared `ApiError` body. */
export class HttpError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly extra: Record<string, unknown>

  constructor(code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.status = STATUS[code]
    this.extra = extra
  }

  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra }
  }
}

export const notFound = (what: string) => new HttpError('not_found', `${what} not found`)
export const conflict = (current: Item) =>
  new HttpError('conflict', 'The item has changed since this version', { current })

/** Parses request input with a shared schema from packages/core, or throws a 400. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    throw new HttpError('invalid_request', `${path}${issue?.message ?? 'Invalid request'}`)
  }
  return result.data
}

// Cursors are opaque to clients: base64url of a JSON tuple of the last row's sort key.

export function encodeCursor(key: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url')
}

export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string): z.output<T> {
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new HttpError('invalid_request', 'Invalid cursor')
  }
  const result = schema.safeParse(raw)
  if (!result.success) throw new HttpError('invalid_request', 'Invalid cursor')
  return result.data
}
