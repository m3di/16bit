import { z } from 'zod'

// The item query cursor (D61). It stays opaque to clients, but it is encoded here rather than
// in `apps/api` so the query schema can refuse a cursor from another order at the edge. Core
// targets plain ES2024 (no `btoa`, no `TextEncoder`), so UTF-8 and base64url are done by hand.

/** Bytes of `text` in UTF-8. Lone surrogates count as U+FFFD (3 bytes), as encoders write them. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

function utf8Encode(text: string): number[] {
  const out: number[] = []
  for (const char of text) {
    let code = char.codePointAt(0) ?? 0
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
    }
  }
  return out
}

/** Strict UTF-8 decoding: `null` on any malformed, overlong or surrogate sequence. */
function utf8Decode(bytes: readonly number[]): string | null {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i] ?? 0
    const [length, min] =
      b < 0x80
        ? [1, 0]
        : b >> 5 === 6
          ? [2, 0x80]
          : b >> 4 === 14
            ? [3, 0x800]
            : b >> 3 === 30
              ? [4, 0x10000]
              : [0, 0]
    if (length === 0 || i + length > bytes.length) return null
    let code = length === 1 ? b : b & (0xff >> (length + 1))
    for (let j = 1; j < length; j++) {
      const next = bytes[i + j] ?? 0
      if (next >> 6 !== 2) return null
      code = (code << 6) | (next & 63)
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
    out += String.fromCodePoint(code)
    i += length
  }
  return out
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64urlEncode(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = Math.min(4, bytes.length - i + 1)
    for (let j = 0; j < chars; j++) out += ALPHABET.charAt((n >> (18 - 6 * j)) & 63)
  }
  return out
}

/** Unpadded base64url only; `null` for anything else, including non-zero trailing bits. */
function base64urlDecode(text: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) return null
  return bytes
}

/**
 * The order an item query page was read in. `updated` and `number` are `order` (D61); `sort`
 * is any attribute `sort`, whose keys the API checks against the folder's attributes.
 */
export const ITEM_CURSOR_ORDERS = ['updated', 'number', 'sort'] as const
export type ItemCursorOrder = (typeof ITEM_CURSOR_ORDERS)[number]

const cursorKeySchema = z.union([z.string().max(20_000), z.number(), z.null()])

/**
 * A decoded cursor: the order it was read in, then the last row's keys. `updated` keys are the
 * last row's `updatedAt` (microsecond text) and ID; `number` keys are its item number alone,
 * unique in its hub; `sort` keys are one per sort key, then the ID.
 */
export const itemCursorSchema = z.discriminatedUnion('order', [
  z.strictObject({
    order: z.literal('updated'),
    after: z.tuple([z.iso.datetime(), z.string().min(1).max(64)]),
  }),
  z.strictObject({ order: z.literal('number'), after: z.tuple([z.int().min(1)]) }),
  z.strictObject({
    order: z.literal('sort'),
    // Up to MAX_SORT_KEYS (3) keys, then the ID.
    after: z.array(cursorKeySchema).min(2).max(4),
  }),
])
export type ItemCursor = z.infer<typeof itemCursorSchema>

/** Encodes as base64url of the JSON tuple `[order, ...after]`. */
export function encodeItemCursor(cursor: ItemCursor): string {
  return base64urlEncode(utf8Encode(JSON.stringify([cursor.order, ...cursor.after])))
}

/** `null` for anything `encodeItemCursor` did not make, including cursors from before M3. */
export function decodeItemCursor(text: string): ItemCursor | null {
  const bytes = base64urlDecode(text)
  const json = bytes && utf8Decode(bytes)
  if (json === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(raw) || raw.length === 0) return null
  const [order, ...after] = raw as unknown[]
  const result = itemCursorSchema.safeParse({ order, after })
  return result.success ? result.data : null
}
