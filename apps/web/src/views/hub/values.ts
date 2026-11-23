import {
  attributeTypes,
  richTextPlainText,
  type Attribute,
  type ItemValues,
  type SelectOption,
} from '@16bit/core'

type Value = ItemValues[string] | undefined

const dateOnly = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })
const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

/** A stored timestamp for people: "Nov 16, 2026, 2:05 PM" in the viewer's zone. */
export const formatTimestamp = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date)
}

/** A value as text for a table cell. Empty and mistyped values show as nothing. */
export function formatValue(attribute: Attribute, value: Value): string {
  if (value === null || value === undefined) return ''
  switch (attribute.type) {
    case 'text':
      return typeof value === 'string' ? attributeTypes.text.render(value, attribute.config) : ''
    case 'number':
      return typeof value === 'number' ? attributeTypes.number.render(value, attribute.config) : ''
    case 'boolean':
      return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : ''
    case 'date': {
      if (typeof value !== 'string') return ''
      if (!attribute.config.includeTime) {
        const date = new Date(`${value}T00:00:00Z`)
        return Number.isNaN(date.getTime()) ? value : dateOnly.format(date)
      }
      return formatTimestamp(value)
    }
    case 'select':
      return typeof value === 'string' ? attributeTypes.select.render(value, attribute.config) : ''
    case 'url':
      return typeof value === 'string' ? value : ''
    case 'auto_id':
      return typeof value === 'number' ? attributeTypes.auto_id.render(value, attribute.config) : ''
    case 'multi_select':
      return Array.isArray(value) ? attributeTypes.multi_select.render(value, attribute.config) : ''
    case 'actor':
    case 'relation':
      return Array.isArray(value) ? value.join(', ') : ''
    case 'rich_text':
      return typeof value === 'object' && !Array.isArray(value) ? richTextPlainText(value) : ''
  }
}

/** The select option a value points at, for its colour. */
export function selectedOption(attribute: Attribute, value: Value): SelectOption | undefined {
  if (attribute.type !== 'select' || typeof value !== 'string') return undefined
  return attribute.config.options.find((o) => o.id === value)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A value as the string an `<input>` or `<select>` holds. */
export function toInput(attribute: Attribute, value: Value): string {
  if (value === null || value === undefined) return ''
  if (attribute.type === 'date' && attribute.config.includeTime && typeof value === 'string') {
    // datetime-local has no zone: show the instant in the viewer's zone.
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return ''
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  // Lists and rich text have their own editors (FieldEditor); they never use this.
  return typeof value === 'object' ? '' : String(value)
}

/** Types edited by their own component (lists, rich text, auto IDs), never through a text input. */
export const OWN_EDITOR_TYPES = [
  'multi_select',
  'actor',
  'auto_id',
  'rich_text',
  'relation',
] as const satisfies readonly Attribute['type'][]
type OwnEditorType = (typeof OWN_EDITOR_TYPES)[number]

export const hasOwnEditor = (
  attribute: Attribute,
): attribute is Extract<Attribute, { type: OwnEditorType }> =>
  (OWN_EDITOR_TYPES as readonly string[]).includes(attribute.type)

export type Parsed = { ok: true; value: ItemValues[string] } | { ok: false; message: string }

/** Turns input text into a stored value. The empty string clears the value. */
export function fromInput(attribute: Attribute, text: string): Parsed {
  if (text.trim() === '' && attribute.type !== 'text') return { ok: true, value: null }
  if (hasOwnEditor(attribute)) return { ok: false, message: 'This field has its own editor' }
  switch (attribute.type) {
    case 'text':
      return { ok: true, value: text === '' ? null : text }
    case 'number': {
      const n = Number(text)
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: 'Enter a number' }
    }
    case 'boolean':
      return { ok: true, value: text === 'true' }
    case 'date': {
      if (!attribute.config.includeTime) return { ok: true, value: text }
      const d = new Date(text)
      return Number.isNaN(d.getTime())
        ? { ok: false, message: 'Enter a date and time' }
        : { ok: true, value: d.toISOString() }
    }
    case 'select':
    case 'url':
      return { ok: true, value: text }
  }
}
