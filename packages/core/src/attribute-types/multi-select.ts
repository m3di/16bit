import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'
import { distinctList, distinctListJsonSchema } from './list.ts'
import { selectConfigSchema, type SelectConfig } from './select.ts'

export const MULTI_SELECT_MAX_VALUES = 100

/** The same options as select. A value is a list of distinct option IDs. */
export const multiSelectConfigSchema = selectConfigSchema
export type MultiSelectConfig = SelectConfig

const optionIds = (config: MultiSelectConfig) => config.options.map((o) => o.id)

/** Option order; a value whose option was deleted sorts after every option. */
const position = (value: string, config: MultiSelectConfig) => {
  const index = optionIds(config).indexOf(value)
  return index === -1 ? config.options.length : index
}

/** The values in option order, so `ord` 0 is the earliest option whatever order was sent. */
const inOptionOrder = (value: string[], config: MultiSelectConfig) =>
  value
    .map((v, i) => ({ v, i, p: position(v, config) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(({ v }) => v)

export const multiSelectType: AttributeType<'multi_select', MultiSelectConfig, string[]> = {
  name: 'multi_select',
  configSchema: multiSelectConfigSchema,
  valueSchema: (config) => {
    const ids = optionIds(config)
    return distinctList(
      z.string().refine((v) => ids.includes(v), { message: 'Unknown option' }),
      MULTI_SELECT_MAX_VALUES,
    )
  },
  readOnly: false,
  isEmpty: (value) => value.length === 0,
  // One item_index row per selected option.
  indexProjection: 'txt',
  project: inOptionOrder,
  // On a list, `in` means "has any of" and `not_in` "has none of".
  filterOperators: ['in', 'not_in', ...EMPTY_OPERATORS],
  sortable: true,
  sortKey: (value, config) => Math.min(...value.map((v) => position(v, config))),
  groupKey: (value, config) => inOptionOrder(value, config).join(','),
  summaries: [...BASE_SUMMARIES],
  jsonSchema: (config) => ({
    ...distinctListJsonSchema({ type: 'string', enum: optionIds(config) }, MULTI_SELECT_MAX_VALUES),
    description: config.options.map((o) => `${o.id} = ${o.label}`).join('; '),
  }),
  render: (value, config) =>
    value === null
      ? ''
      : inOptionOrder(value, config)
          .map((v) => config.options.find((o) => o.id === v)?.label ?? v)
          .join(', '),
}
