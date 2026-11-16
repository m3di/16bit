import { z } from 'zod'

/** An array of distinct strings, each checked by `item`, at most `max` long. */
export const distinctList = (item: z.ZodType<string>, max: number): z.ZodType<string[]> =>
  z
    .array(item)
    .max(max)
    .refine((values) => new Set(values).size === values.length, {
      message: 'Values must be distinct',
    })

/** The JSON Schema fragment for `distinctList`. */
export const distinctListJsonSchema = (items: Record<string, unknown>, max: number) => ({
  type: 'array',
  items,
  uniqueItems: true,
  maxItems: max,
})
