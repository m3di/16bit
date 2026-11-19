import type { AttributeTypeName, PaletteColor, SelectOption } from '@16bit/core'
import { PALETTE_COLORS } from './palette.ts'

/** The states every settings component can show besides `ready` (D18, plus a 404). */
export type SettingsState = 'ready' | 'loading' | 'empty' | 'error' | 'no-permission' | 'not-found'

/**
 * ConfirmDialog's "type the name to confirm": an exact match, ignoring only surrounding spaces.
 * Case counts, so "engineering" does not delete "Engineering".
 */
export function confirmTextMatches(typed: string, expected: string): boolean {
  return expected.trim() !== '' && typed.trim() === expected.trim()
}

/**
 * An arrow key on a closed menu button opens the menu, and says where focus lands. Enter and
 * Space open it through the button's click, on the first item.
 */
export function menuOpenFocus(key: string): 'first' | 'last' | null {
  if (key === 'ArrowDown') return 'first'
  if (key === 'ArrowUp') return 'last'
  return null
}

/** The parts of a button's `getBoundingClientRect()` a popup menu is placed from. */
export interface AnchorRect {
  top: number
  left: number
  bottom: number
  right: number
}

/**
 * Whether a menu's button has moved since the menu was placed. A scroll or resize event that
 * leaves the button where it was (such as the late event from the scroll that brought the button
 * into view before the menu opened, issue 157) must not close the menu. Sub-pixel jitter is ignored.
 */
export function anchorMoved(placed: AnchorRect, now: AnchorRect): boolean {
  return (['top', 'left', 'bottom', 'right'] as const).some(
    (side) => Math.abs(placed[side] - now[side]) >= 1,
  )
}

/** Names and one-line descriptions for the attribute type picker. Every core type has one. */
export const ATTRIBUTE_TYPE_INFO: Record<AttributeTypeName, { label: string; hint: string }> = {
  text: { label: 'Text', hint: 'A short line of text, such as a title.' },
  rich_text: { label: 'Rich text', hint: 'Formatted text with lists, links, and code.' },
  number: { label: 'Number', hint: 'A number, such as points or an estimate.' },
  boolean: { label: 'Checkbox', hint: 'Yes or no.' },
  date: { label: 'Date', hint: 'A day, or a day and time.' },
  select: { label: 'Select', hint: 'One option from a list you define.' },
  multi_select: { label: 'Multi-select', hint: 'Any number of options from a list.' },
  url: { label: 'URL', hint: 'A web or mail address.' },
  actor: { label: 'Actor', hint: 'A person or an agent in this workspace.' },
  relation: { label: 'Relation', hint: 'Links to items in this hub or another.' },
  auto_id: { label: 'Auto ID', hint: 'A number given to each new item, after the prefix.' },
}

/** The picker's order: common types first. */
export const ATTRIBUTE_TYPE_ORDER: readonly AttributeTypeName[] = [
  'text',
  'rich_text',
  'number',
  'boolean',
  'date',
  'select',
  'multi_select',
  'url',
  'actor',
  'relation',
  'auto_id',
]

/** Core's limit on options per select attribute. */
export const MAX_OPTIONS = 500

/** A new option ID that is not in use. Values store the ID, so it never changes (D5). */
export function newOptionId(
  options: readonly SelectOption[],
  random: () => number = Math.random,
): string {
  const used = new Set(options.map((o) => o.id))
  for (;;) {
    const id = `opt_${random().toString(36).slice(2, 10).padEnd(8, '0')}`
    if (!used.has(id)) return id
  }
}

/** New options take the next palette colour, so a fresh list is easy to tell apart. */
export function nextOptionColor(options: readonly SelectOption[]): PaletteColor {
  return PALETTE_COLORS[options.length % PALETTE_COLORS.length] ?? 'indigo'
}

/** Moves the option at `from` by one place up or down. Out of range returns the same list. */
export function moveOption<T>(options: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by
  if (from < 0 || from >= options.length || to < 0 || to >= options.length) return [...options]
  const next = [...options]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

/**
 * Field errors for an options list, keyed by option ID: a blank name, or a name another option
 * already has (case and surrounding spaces ignored, so "Done" and "done " clash).
 */
export function optionErrors(options: readonly SelectOption[]): Record<string, string> {
  const errors: Record<string, string> = {}
  const seen = new Map<string, string>()
  for (const o of options) {
    const key = o.label.trim().toLocaleLowerCase('en')
    if (!key) {
      errors[o.id] = 'Name the option.'
      continue
    }
    if (seen.has(key)) errors[o.id] = 'Another option has this name.'
    else seen.set(key, o.id)
  }
  return errors
}

const formatCount = (count: number) => new Intl.NumberFormat('en').format(count)

/** "1,280 items", as shown beside an option. */
export function itemCount(count: number): string {
  return count === 1 ? '1 item' : `${formatCount(count)} items`
}

/** "12 items use this option" in plain words, for the confirm step before removing it (D51). */
export function usageText(count: number): string {
  if (count === 1) return '1 item uses this option'
  return `${formatCount(count)} items use this option`
}

/**
 * The confirm before removing an option that items use (D51). Saving strips the option from every
 * item holding it, with a revision each (D55), so that is what it says will happen.
 */
export function removeOptionMessage(count: number): string {
  return `${usageText(count)}. Saving clears it from ${count === 1 ? 'that item' : 'those items'}, with a revision each.`
}
