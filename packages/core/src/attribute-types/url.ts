import { z } from 'zod'
import { noNul } from '../nul.ts'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

export const URL_MAX_LENGTH = 2048

/** An absolute http or https URL. Email and phone are formats of text, not URLs (D12). */
export const urlConfigSchema = z.strictObject({})
export type UrlConfig = z.infer<typeof urlConfigSchema>

/** Surrounding whitespace is trimmed. `javascript:`, `mailto:` and other schemes are refused. */
export const urlValueSchema = z
  .url({ protocol: /^https?$/i })
  .max(URL_MAX_LENGTH)
  .refine(...noNul)

export const urlType: AttributeType<'url', UrlConfig, string> = {
  name: 'url',
  configSchema: urlConfigSchema,
  valueSchema: () => urlValueSchema,
  readOnly: false,
  isEmpty: () => false,
  indexProjection: 'txt',
  project: (value) => [value],
  filterOperators: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', ...EMPTY_OPERATORS],
  sortable: true,
  sortKey: (value) => value.toLowerCase(),
  groupKey: (value) => value,
  summaries: [...BASE_SUMMARIES, 'count_unique'],
  jsonSchema: () => ({ type: 'string', format: 'uri', maxLength: URL_MAX_LENGTH }),
  render: (value) => value ?? '',
}
