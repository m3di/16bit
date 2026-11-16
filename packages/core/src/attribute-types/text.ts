import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

export const TEXT_MAX_LENGTH = 10_000

export const textConfigSchema = z.strictObject({
  maxLength: z.int().min(1).max(TEXT_MAX_LENGTH).optional(),
})
export type TextConfig = z.infer<typeof textConfigSchema>

export const textType: AttributeType<'text', TextConfig, string> = {
  name: 'text',
  configSchema: textConfigSchema,
  valueSchema: (config) => z.string().max(config.maxLength ?? TEXT_MAX_LENGTH),
  isEmpty: (value) => value === '',
  indexProjection: 'txt',
  project: (value) => value,
  filterOperators: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', ...EMPTY_OPERATORS],
  sortKey: (value) => value.toLowerCase(),
  groupKey: (value) => value,
  summaries: [...BASE_SUMMARIES, 'count_unique'],
  jsonSchema: (config) => ({ type: 'string', maxLength: config.maxLength ?? TEXT_MAX_LENGTH }),
  render: (value) => value ?? '',
}
