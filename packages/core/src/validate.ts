import {
  attributeTypes,
  type AttributeType,
  type AttributeTypeName,
  type ItemValue,
} from './attribute-types/index.ts'
import type { Attribute, ItemValues } from './entities.ts'

/** An attribute as it applies to one folder: the definition plus the folder's `required` flag. */
export interface FolderAttributeDefinition {
  attribute: Attribute
  required: boolean
}

export type ValueErrorCode = 'unknown_attribute' | 'required' | 'invalid_value'

export interface ValueError {
  attributeId: string
  code: ValueErrorCode
  message: string
}

export type ValidateItemValuesResult =
  { ok: true; values: ItemValues } | { ok: false; errors: ValueError[] }

export interface ValidateItemValuesOptions {
  /**
   * `false` (create): every required attribute must be present and non-empty.
   * `true` (patch): only the given keys are checked, but a required attribute cannot be cleared.
   */
  partial?: boolean
}

type ParseResult = { ok: true; value: ItemValue | null } | { ok: false; message: string }

function parseWith<C, V extends ItemValue>(
  type: AttributeType<AttributeTypeName, C, V>,
  config: C,
  input: unknown,
): ParseResult {
  const result = type.valueSchema(config).safeParse(input)
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'Invalid value' }
  }
  return { ok: true, value: type.isEmpty(result.data, config) ? null : result.data }
}

function parseValue(attribute: Attribute, input: unknown): ParseResult {
  if (input === null) return { ok: true, value: null }
  switch (attribute.type) {
    case 'text':
      return parseWith(attributeTypes.text, attribute.config, input)
    case 'number':
      return parseWith(attributeTypes.number, attribute.config, input)
    case 'boolean':
      return parseWith(attributeTypes.boolean, attribute.config, input)
    case 'date':
      return parseWith(attributeTypes.date, attribute.config, input)
    case 'select':
      return parseWith(attributeTypes.select, attribute.config, input)
  }
}

/**
 * Validates item values against a folder's attributes. Runs before the write transaction.
 * Returns the normalised values (empty values become `null`) or every error found.
 */
export function validateItemValues(
  folderAttributes: readonly FolderAttributeDefinition[],
  values: Readonly<Record<string, unknown>>,
  options: ValidateItemValuesOptions = {},
): ValidateItemValuesResult {
  const byId = new Map(folderAttributes.map((fa) => [fa.attribute.id, fa]))
  const errors: ValueError[] = []
  const out: ItemValues = {}

  for (const [attributeId, input] of Object.entries(values)) {
    const definition = byId.get(attributeId)
    if (!definition) {
      errors.push({
        attributeId,
        code: 'unknown_attribute',
        message: 'Not an attribute of this folder',
      })
      continue
    }
    const parsed = parseValue(definition.attribute, input)
    if (!parsed.ok) {
      errors.push({ attributeId, code: 'invalid_value', message: parsed.message })
    } else if (parsed.value === null && definition.required) {
      errors.push({ attributeId, code: 'required', message: 'A value is required' })
    } else {
      out[attributeId] = parsed.value
    }
  }

  if (!options.partial) {
    for (const { attribute, required } of folderAttributes) {
      if (required && !Object.hasOwn(values, attribute.id)) {
        errors.push({ attributeId: attribute.id, code: 'required', message: 'A value is required' })
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out }
}
