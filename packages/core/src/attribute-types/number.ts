import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'

/** Percent and currency are formats of number, not separate types (D12). */
export const numberConfigSchema = z
  .strictObject({
    format: z.enum(['plain', 'percent', 'currency']).default('plain'),
    /** ISO 4217 code, required when format is currency. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    decimals: z.int().min(0).max(10).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((c) => c.format !== 'currency' || c.currency !== undefined, {
    message: 'currency is required when format is currency',
    path: ['currency'],
  })
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, {
    message: 'min must not exceed max',
    path: ['min'],
  })
export type NumberConfig = z.infer<typeof numberConfigSchema>

function valueSchema(config: NumberConfig) {
  let schema = z.number()
  if (config.min !== undefined) schema = schema.min(config.min)
  if (config.max !== undefined) schema = schema.max(config.max)
  return schema
}

function render(value: number | null, config: NumberConfig): string {
  if (value === null) return ''
  const fixed = config.decimals === undefined ? String(value) : value.toFixed(config.decimals)
  if (config.format === 'percent') return `${fixed}%`
  if (config.format === 'currency') return `${fixed} ${config.currency ?? ''}`.trimEnd()
  return fixed
}

export const numberType: AttributeType<'number', NumberConfig, number> = {
  name: 'number',
  configSchema: numberConfigSchema,
  valueSchema,
  isEmpty: () => false,
  indexProjection: 'num',
  project: (value) => [value],
  filterOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...EMPTY_OPERATORS],
  sortKey: (value) => value,
  groupKey: (value) => String(value),
  summaries: [...BASE_SUMMARIES, 'sum', 'avg', 'min', 'max'],
  jsonSchema: (config) => ({
    type: 'number',
    ...(config.min !== undefined && { minimum: config.min }),
    ...(config.max !== undefined && { maximum: config.max }),
  }),
  render,
}
