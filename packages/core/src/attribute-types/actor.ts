import { z } from 'zod'
import { idSchema } from '../ids.ts'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'
import { distinctList, distinctListJsonSchema } from './list.ts'

export const ACTOR_MAX_VALUES = 50

/**
 * People or agents in the workspace, by principal ID. The value is always a list; with
 * `multiple` off it holds at most one. That a principal exists in the workspace is checked by
 * the server, not here.
 */
export const actorConfigSchema = z.strictObject({
  multiple: z.boolean().default(false),
})
export type ActorConfig = z.infer<typeof actorConfigSchema>

const maxValues = (config: ActorConfig) => (config.multiple ? ACTOR_MAX_VALUES : 1)

export const actorType: AttributeType<'actor', ActorConfig, string[]> = {
  name: 'actor',
  configSchema: actorConfigSchema,
  valueSchema: (config) => distinctList(idSchema, maxValues(config)),
  readOnly: false,
  isEmpty: (value) => value.length === 0,
  // One item_index row per principal.
  indexProjection: 'txt',
  project: (value) => [...value],
  // On a list, `in` means "has any of" and `not_in` "has none of".
  filterOperators: ['in', 'not_in', ...EMPTY_OPERATORS],
  // Names live on the principal, so an ID order would look random.
  sortable: false,
  sortKey: (value) => [...value].sort()[0] ?? '',
  groupKey: (value) => [...value].sort().join(','),
  summaries: [...BASE_SUMMARIES],
  jsonSchema: (config) => ({
    ...distinctListJsonSchema({ type: 'string', description: 'Principal ID' }, maxValues(config)),
  }),
  render: (value) => (value === null ? '' : value.join(', ')),
}
