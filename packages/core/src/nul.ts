// Postgres can't store U+0000 in `text` or in a `jsonb` string, so a value carrying it would pass
// the schemas and fail the write with a 500 (#221). Every free-text string a client sends into
// an item value, a cause, or a text filter is checked with these, and refused like any other
// invalid value: 422 `invalid_values` for item values, 400 `invalid_request` elsewhere.

export const NUL_MESSAGE = 'Text cannot contain the NUL character (U+0000)'

/** True if `text` holds U+0000. */
export const hasNul = (text: string): boolean => text.includes('\u0000')

/** A refinement for `z.string()` schemas: `.refine(...noNul)`. */
export const noNul = [(text: string) => !hasNul(text), { message: NUL_MESSAGE }] as const
