import { z } from 'zod'
import { idSchema } from '../ids.ts'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'
import { distinctList, distinctListJsonSchema } from './list.ts'

export const RELATION_MAX_VALUES = 100

/**
 * Links to items in `targetHubId`, by item ID. The value is always a list; with `multiple`
 * off it holds at most one. Links are kept in the `link` table (D7) in step with the value.
 *
 * Cross-hub relations are off by default (D11): with `crossHub` false, `targetHubId` must be
 * the attribute's own hub, which `attributeSchema` checks. That the linked items exist, sit in
 * the target hub, and can be read is checked by the server, not here.
 */
export const relationConfigSchema = z.strictObject({
  targetHubId: idSchema,
  crossHub: z.boolean().default(false),
  multiple: z.boolean().default(true),
})
export type RelationConfig = z.infer<typeof relationConfigSchema>

const maxValues = (config: RelationConfig) => (config.multiple ? RELATION_MAX_VALUES : 1)

export const relationType: AttributeType<'relation', RelationConfig, string[]> = {
  name: 'relation',
  configSchema: relationConfigSchema,
  valueSchema: (config) => distinctList(idSchema, maxValues(config)),
  readOnly: false,
  isEmpty: (value) => value.length === 0,
  // One item_index row per linked item.
  indexProjection: 'txt',
  project: (value) => [...value],
  // On a list, `in` means "links to any of" and `not_in` "links to none of".
  filterOperators: ['in', 'not_in', ...EMPTY_OPERATORS],
  // Titles live on the linked items, so an ID order would look random.
  sortable: false,
  sortKey: (value) => [...value].sort()[0] ?? '',
  groupKey: (value) => [...value].sort().join(','),
  summaries: [...BASE_SUMMARIES],
  jsonSchema: (config) =>
    distinctListJsonSchema(
      { type: 'string', description: `Item ID in hub ${config.targetHubId}` },
      maxValues(config),
    ),
  render: (value) => (value === null ? '' : value.join(', ')),
}
