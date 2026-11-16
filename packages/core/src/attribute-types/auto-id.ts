import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

/**
 * A number the server assigns when the item is created and never changes. It is read-only
 * for clients: `validateItemValues` refuses any value they send. The value is the item's
 * per-hub `seqId`, so numbers are never reused (docs/ARCHITECTURE.md). `prefix` only changes
 * how it is shown, for example `BLD-12`.
 */
export const autoIdConfigSchema = z.strictObject({
  prefix: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/)
    .optional(),
})
export type AutoIdConfig = z.infer<typeof autoIdConfigSchema>

const render = (value: number | null, config: AutoIdConfig) =>
  value === null ? '' : config.prefix ? `${config.prefix}-${String(value)}` : String(value)

export const autoIdType: AttributeType<'auto_id', AutoIdConfig, number> = {
  name: 'auto_id',
  configSchema: autoIdConfigSchema,
  valueSchema: () => z.int().min(1),
  readOnly: true,
  isEmpty: () => false,
  indexProjection: 'num',
  project: (value) => [value],
  filterOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', ...EMPTY_OPERATORS],
  sortable: true,
  sortKey: (value) => value,
  groupKey: (value) => String(value),
  summaries: [...BASE_SUMMARIES, 'min', 'max'],
  jsonSchema: () => ({
    type: 'integer',
    minimum: 1,
    readOnly: true,
    description: 'Assigned by the server; do not send',
  }),
  render,
}
