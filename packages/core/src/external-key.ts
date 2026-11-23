import { z } from 'zod'

// External keys (D64, #199): a client's own identity for an item, unique per hub.

export const EXTERNAL_KEY_MAX_LENGTH = 200

/**
 * Whitespace as JavaScript's `\s` matches it (Unicode spaces, line breaks, the byte order mark).
 * A key may hold it inside, never at either end. Migration `0015_item_external_key` checks
 * the same set in the database.
 */
const SURROUNDING_WHITESPACE = /^\s|\s$/

/** Control characters (Unicode `Cc`) and lone surrogates, which would not survive as UTF-8. */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cs}]/u

/**
 * An item's external key (D64): opaque text, 1 to 200 characters (code points, as Postgres
 * counts them), no control characters, no whitespace at either end. Compared exactly: case,
 * accents and Unicode normalisation all count. Unique per hub; a key another item of the hub
 * holds is 409 `key_taken`. Sent URL-encoded as the last path segment of the by-key routes.
 */
export const externalKeySchema = z
  .string()
  .min(1)
  .refine((key) => Array.from(key).length <= EXTERNAL_KEY_MAX_LENGTH, {
    message: `At most ${String(EXTERNAL_KEY_MAX_LENGTH)} characters`,
  })
  .refine((key) => !FORBIDDEN_CHARACTERS.test(key), {
    message: 'No control characters',
  })
  .refine((key) => !SURROUNDING_WHITESPACE.test(key), {
    message: 'No whitespace at the start or end',
  })
export type ExternalKey = z.infer<typeof externalKeySchema>

/**
 * Inside a batch only (D65): one element of a relation value naming an item by its external key
 * instead of its ID, for example `["it_1", { "externalKey": "src/app.ts" }]`. The key is looked
 * up in the writing item's hub, which must be the relation's target hub, and may name an item
 * an earlier operation of the same batch created. A key no item holds fails that operation
 * alone, with 422 `invalid_values`. Single-item routes take item IDs only.
 */
export const relationKeyRefSchema = z.strictObject({ externalKey: externalKeySchema })
export type RelationKeyRef = z.infer<typeof relationKeyRefSchema>
