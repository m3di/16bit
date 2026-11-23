import type {
  AggregateGroup,
  AggregateGroupKey,
  Attribute,
  HubDescription,
  Item,
  ItemValues,
  LinkedItem,
  Measure,
  MeasureValue,
} from '@16bit/core'
import type { FieldValue, ListField, ListGroup } from '../../ui/blocks.ts'
import { formatValue, selectedOption } from '../hub/values.ts'

// From block config and view data to what the presentation components show (D77). Only what
// the data says: an empty value is the configured empty text or nothing, never a guess.

/** Names the renderer resolves: actors from the member list (D80), linked items by ID. */
export interface Names {
  actor: (principalId: string) => string
  item: (itemId: string) => string
}

export const attributeOf = (description: HubDescription | null, id: string) =>
  description?.attributes.find((a) => a.id === id)

const number = new Intl.NumberFormat('en')
export const formatNumber = (n: number) => number.format(n)

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (Array.isArray(value) && value.length === 0)

/**
 * One shown value. Empty is the configured empty text ("No epic", "?"), or nothing at all, so
 * screen readers hear nothing for a field with no value.
 */
export function fieldValue(
  attribute: Attribute,
  value: ItemValues[string] | undefined,
  names: Names,
  emptyText?: string,
): FieldValue | undefined {
  if (isEmpty(value)) return emptyText ? { text: emptyText, empty: true } : undefined
  const list = Array.isArray(value) ? value.map(String) : []
  switch (attribute.type) {
    case 'select': {
      const option = selectedOption(attribute, value)
      return {
        text: formatValue(attribute, value),
        ...(option?.color ? { color: option.color } : {}),
      }
    }
    case 'actor':
      return { text: list.map(names.actor).join(', ') }
    case 'relation':
      return { text: list.map(names.item).join(', ') }
    case 'auto_id':
      return { text: formatValue(attribute, value), mono: true }
    default:
      return { text: formatValue(attribute, value) }
  }
}

/**
 * The fields of a list or board, in config order. An auto-ID attribute is the item's ID, shown
 * before the title as the backlog mockup does (`lead`); numbers line up on the right.
 */
export function listFields(
  description: HubDescription | null,
  fields: readonly { attribute: string }[],
): ListField[] {
  return fields.flatMap((f) => {
    const a = attributeOf(description, f.attribute)
    if (!a) return []
    return [
      {
        key: a.id,
        label: a.name,
        ...(a.type === 'auto_id' ? { lead: true } : {}),
        ...(a.type === 'number' ? { align: 'end' as const } : {}),
      },
    ]
  })
}

/** An item's values for the fields shown, with their empty texts. */
export function rowValues(
  description: HubDescription | null,
  fields: readonly { attribute: string; emptyText?: string | undefined }[],
  item: Item,
  names: Names,
): Record<string, FieldValue | undefined> {
  const out: Record<string, FieldValue | undefined> = {}
  for (const f of fields) {
    const a = attributeOf(description, f.attribute)
    if (a) out[a.id] = fieldValue(a, item.values[a.id], names, f.emptyText)
  }
  return out
}

/** The title of an item in a row or card: its title value, else its ID. */
export function titleOf(description: HubDescription | null, item: Item): string {
  const id = description?.hub.titleAttributeId
  const value = id ? item.values[id] : undefined
  const title = typeof value === 'string' ? value.trim() : ''
  return title || `${description?.hub.idPrefix ?? ''}-${String(item.seqId)}`
}

const dateOnly = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })

/** A group's name. Date buckets are their first day; hidden targets are one group (D80). */
export function groupLabel(
  key: AggregateGroupKey,
  attribute: Attribute | undefined,
  names: Names,
): string {
  switch (key.kind) {
    case 'all':
      return ''
    case 'empty':
      return attribute ? `No ${attribute.name.toLowerCase()}` : 'No value'
    case 'no_access':
      return 'Items you cannot see'
    case 'other':
      return 'Other'
    case 'value': {
      if (key.label) return key.label
      if (!attribute) return String(key.value)
      if (attribute.type === 'actor') return names.actor(String(key.value))
      if (attribute.type === 'relation') return names.item(String(key.value))
      if (attribute.type === 'date' && typeof key.value === 'string') {
        const d = new Date(`${key.value.slice(0, 10)}T00:00:00Z`)
        return Number.isNaN(d.getTime()) ? key.value : dateOnly.format(d)
      }
      if (typeof key.value === 'boolean') return key.value ? attribute.name : `Not ${attribute.name.toLowerCase()}`
      return formatValue(attribute, key.value as ItemValues[string]) || String(key.value)
    }
  }
}

/** A select option's colour for a group, if it has one. */
export function groupColor(key: AggregateGroupKey, attribute: Attribute | undefined) {
  if (key.kind !== 'value' || !attribute) return undefined
  return selectedOption(attribute, key.value as ItemValues[string])?.color
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** A measure's value as a group header says it ("19 points", "1 without points"). */
export function measureText(
  measure: Measure,
  value: MeasureValue | undefined,
  description: HubDescription | null,
): string {
  const a = measure.attribute ? attributeOf(description, measure.attribute) : undefined
  const name = a?.name.toLowerCase() ?? ''
  if (value === null || value === undefined) {
    return measure.fn === 'sum' || measure.fn === 'avg' ? `No ${name}` : ''
  }
  if (typeof value === 'string') {
    const d = a ? formatValue(a, value) : value
    return measure.fn === 'earliest' ? `Earliest ${d}` : measure.fn === 'latest' ? `Latest ${d}` : d
  }
  const n = formatNumber(value)
  switch (measure.fn) {
    case 'count':
      return `${n} ${plural(value, 'item', 'items')}`
    case 'count_empty':
      return `${n} without ${name}`
    case 'count_not_empty':
      return `${n} with ${name}`
    case 'count_unique':
      return `${n} different ${name}`
    case 'count_true':
      return `${n} ${name}`
    case 'count_false':
      return `${n} not ${name}`
    case 'sum':
      return `${n} ${name}`
    case 'avg':
      return `${n} ${name} on average`
    case 'min':
      return `Lowest ${name} ${n}`
    case 'max':
      return `Highest ${name} ${n}`
    default:
      return n
  }
}

export type DateBucket = 'day' | 'week' | 'month'

/** The first day of the bucket a date falls in: the day, its week (from Monday) or month. */
export function bucketStart(value: string, bucket: DateBucket): string {
  const day = value.slice(0, 10)
  if (bucket === 'day') return day
  if (bucket === 'month') return `${day.slice(0, 7)}-01`
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Whether an item falls in a group, by the grouped attribute's value. */
function inGroup(
  item: Item,
  key: AggregateGroupKey,
  attribute: Attribute,
  bucket: DateBucket | undefined,
) {
  const value = item.values[attribute.id]
  switch (key.kind) {
    case 'all':
      return true
    case 'empty':
      return isEmpty(value)
    case 'value':
      if (Array.isArray(value)) return value.map(String).includes(String(key.value))
      if (bucket && typeof value === 'string' && typeof key.value === 'string') {
        return bucketStart(value, bucket) === key.value.slice(0, 10)
      }
      return value === key.value
    default:
      // Hidden targets and folded groups: a row's value does not say which it is in.
      return false
  }
}

/**
 * A list's groups: the server's groups (in its order, with their measures) holding the rows of
 * each, as the rows' values say. A multi-valued attribute puts a row in each of its groups
 * (D80). Hidden (`no_access`) and folded (`other`) groups get no rows, since a row's value does
 * not name them; they show their measures. Timestamps bucket by their UTC day.
 */
export function listGroups(options: {
  items: readonly Item[]
  groups: readonly AggregateGroup[] | undefined
  attribute: Attribute | undefined
  bucket?: DateBucket | undefined
  measures: readonly Measure[]
  description: HubDescription | null
  names: Names
  row: (item: Item) => ListGroup['rows'][number]
  /** Items past the binding's limit, for "+N more" on an ungrouped list. */
  more: number
}): ListGroup[] {
  const { items, groups, attribute, measures, description, names, row } = options
  if (!groups || !attribute) {
    return [{ id: 'all', label: '', rows: items.map(row), more: options.more }]
  }
  return groups.map((g, i) => ({
    id: g.key.kind === 'value' ? `v:${String(g.key.value)}` : `${g.key.kind}:${String(i)}`,
    label: groupLabel(g.key, attribute, names),
    measures: measures.map((m, j) => measureText(m, g.values[j], description)).filter(Boolean),
    rows: items.filter((item) => inGroup(item, g.key, attribute, options.bucket)).map(row),
  }))
}

/** The group a "New item" under it presets, or none (empty, hidden and folded groups). */
export function groupPreset(
  groupId: string,
  groups: readonly AggregateGroup[] | undefined,
  attribute: Attribute | undefined,
): { attribute: string; value: string | number | boolean } | undefined {
  if (!attribute || !groups) return undefined
  const g = groups.find((x) => x.key.kind === 'value' && `v:${String(x.key.value)}` === groupId)
  if (g?.key.kind !== 'value' || attribute.type === 'date') return undefined
  return { attribute: attribute.id, value: g.key.value }
}

/**
 * Points done per day from the server's "remaining" series (D82): what each day took off the
 * day before, the first day from the total. Days after today are `null` and do nothing.
 */
export function doneByDay(
  total: number,
  days: readonly { date: string; remaining: number | null }[],
): Record<string, number> {
  const out: Record<string, number> = {}
  let before = total
  for (const d of days) {
    if (d.remaining === null) continue
    const done = before - d.remaining
    if (done !== 0) out[d.date] = done
    before = d.remaining
  }
  return out
}

/** A relation's label from the answer's `linked`, else from what the page already knows. */
export function linkedLabel(
  id: string,
  linked: Readonly<Record<string, LinkedItem>> | undefined,
  hubOf: (hubId: string) => HubDescription | null,
): string {
  const l = linked?.[id]
  if (l?.access === 'none') return 'No access'
  if (l?.access === 'read') return titleOf(hubOf(l.item.hubId), l.item)
  return 'Linked item'
}
