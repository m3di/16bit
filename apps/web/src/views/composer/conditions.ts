import {
  attributeTypes,
  type Attribute,
  type Filter,
  type FilterCondition,
  type FilterOperator,
  type Principal,
} from '@16bit/core'
import { stableJson } from './tree.ts'
import { LIST_OPS, NO_VALUE_OPS } from './words.ts'

// The one-level condition list (Q10): "match all" or "match any" of plain conditions. Anything
// deeper, or a value the list has no editor for (`$now`), is edited as JSON.

export type MatchMode = 'and' | 'or'

export interface ConditionList {
  mode: MatchMode
  rows: FilterCondition[]
}

const isCondition = (f: unknown): f is FilterCondition =>
  typeof f === 'object' && f !== null && 'op' in f && 'attribute' in f

/** The filter as a flat list, or null when it nests. No filter is an empty "all". */
export function flatten(where: unknown): ConditionList | null {
  if (where === undefined || where === null) return { mode: 'and', rows: [] }
  if (isCondition(where)) return { mode: 'and', rows: [where] }
  if (typeof where !== 'object') return null
  for (const mode of ['and', 'or'] as const) {
    if (mode in where) {
      const list = (where as Record<string, unknown>)[mode]
      if (Array.isArray(list) && list.every(isCondition)) return { mode, rows: list }
      return null
    }
  }
  return null
}

/** The filter for a list. An empty list is no filter, or `{ and: [] }` where one is required. */
export function build(list: ConditionList, required: boolean): Filter | undefined {
  if (list.rows.length === 0) return required ? { and: [] } : undefined
  return list.mode === 'and' ? { and: list.rows } : { or: list.rows }
}

export const operatorsFor = (attribute: Attribute | undefined): readonly FilterOperator[] =>
  attribute ? attributeTypes[attribute.type].filterOperators : []

/** A value to pick from a list: an option, "Me", a block, a person. */
export interface ValueChoice {
  key: string
  label: string
  value: unknown
}

/** What a condition's value is edited with. */
export type ValueEditor =
  | { kind: 'none' }
  /** Pick some (in, not_in): `choices`, plus free text when `free`. */
  | { kind: 'many'; choices: ValueChoice[]; free: 'text' | 'number' | null }
  | { kind: 'one-of'; choices: ValueChoice[] }
  | { kind: 'input'; input: 'text' | 'number' | 'date' }

export function valueEditor(
  attribute: Attribute | undefined,
  op: FilterOperator,
  extras: { blocks: { id: string; label: string }[] | null; people: readonly Principal[] },
): ValueEditor {
  if (!attribute || NO_VALUE_OPS.includes(op)) return { kind: 'none' }
  const options =
    attribute.type === 'select' || attribute.type === 'multi_select'
      ? attribute.config.options.map((o) => ({ key: o.id, label: o.label, value: o.id }))
      : null
  const numeric = attribute.type === 'number' || attribute.type === 'auto_id'
  if (LIST_OPS.includes(op)) {
    if (options) return { kind: 'many', choices: options, free: null }
    if (attribute.type === 'actor') {
      return {
        kind: 'many',
        choices: [
          { key: '$me', label: 'Me (whoever is reading)', value: { $me: true } },
          ...extras.people.map((p) => ({ key: p.id, label: p.name, value: p.id })),
        ],
        free: null,
      }
    }
    if (attribute.type === 'relation') {
      return {
        kind: 'many',
        choices: (extras.blocks ?? []).map((b) => ({
          key: `$block:${b.id}`,
          label: `The item of ${b.label}`,
          value: { $block: b.id },
        })),
        free: 'text',
      }
    }
    return { kind: 'many', choices: [], free: numeric ? 'number' : 'text' }
  }
  if (options) return { kind: 'one-of', choices: options }
  if (attribute.type === 'boolean') {
    return {
      kind: 'one-of',
      choices: [
        { key: 'true', label: 'Yes', value: true },
        { key: 'false', label: 'No', value: false },
      ],
    }
  }
  if (numeric) return { kind: 'input', input: 'number' }
  if (attribute.type === 'date') return { kind: 'input', input: 'date' }
  return { kind: 'input', input: 'text' }
}

const primitive = (v: unknown) => typeof v === 'string' || typeof v === 'number'

/** Whether the editor can show `value` as it is; else it is edited as JSON. */
export function representable(editor: ValueEditor, value: unknown): boolean {
  switch (editor.kind) {
    case 'none':
      return true
    case 'many': {
      if (value === undefined) return true
      if (!Array.isArray(value)) return false
      return value.every(
        (v) =>
          editor.choices.some((c) => stableJson(c.value) === stableJson(v)) ||
          (editor.free !== null && primitive(v)),
      )
    }
    case 'one-of':
      return (
        value === undefined || editor.choices.some((c) => stableJson(c.value) === stableJson(value))
      )
    case 'input':
      return value === undefined || primitive(value)
  }
}

/** What an operator takes: no value, one, or a list. */
export const valueShape = (op: FilterOperator): 'none' | 'one' | 'list' =>
  NO_VALUE_OPS.includes(op) ? 'none' : LIST_OPS.includes(op) ? 'list' : 'one'

/** A value to start a condition with: nothing, or an empty list. */
export const startValue = (op: FilterOperator): unknown =>
  NO_VALUE_OPS.includes(op) ? undefined : LIST_OPS.includes(op) ? [] : undefined
