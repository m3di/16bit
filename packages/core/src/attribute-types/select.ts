import { z } from 'zod'
import { paletteColorSchema } from '../palette.ts'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

export const selectOptionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  color: paletteColorSchema.optional(),
})
export type SelectOption = z.infer<typeof selectOptionSchema>

/** Values store the option ID, so renaming a label never touches items (D5). */
export const selectConfigSchema = z.strictObject({
  options: z
    .array(selectOptionSchema)
    .max(500)
    .refine((options) => new Set(options.map((o) => o.id)).size === options.length, {
      message: 'option ids must be unique',
    }),
})
export type SelectConfig = z.infer<typeof selectConfigSchema>

const optionIds = (config: SelectConfig) => config.options.map((o) => o.id)

export const selectType: AttributeType<'select', SelectConfig, string> = {
  name: 'select',
  configSchema: selectConfigSchema,
  valueSchema: (config) => {
    const ids = optionIds(config)
    return z.string().refine((v) => ids.includes(v), { message: 'Unknown option' })
  },
  isEmpty: () => false,
  indexProjection: 'txt',
  project: (value) => value,
  filterOperators: ['eq', 'neq', 'in', 'not_in', ...EMPTY_OPERATORS],
  // Sorts by option order, not by label. A value whose option was deleted sorts last.
  sortKey: (value, config) => {
    const index = optionIds(config).indexOf(value)
    return index === -1 ? config.options.length : index
  },
  groupKey: (value) => value,
  summaries: [...BASE_SUMMARIES, 'count_unique'],
  jsonSchema: (config) => ({
    type: 'string',
    enum: optionIds(config),
    description: config.options.map((o) => `${o.id} = ${o.label}`).join('; '),
  }),
  render: (value, config) =>
    value === null ? '' : (config.options.find((o) => o.id === value)?.label ?? value),
}
