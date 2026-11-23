import { Comment, Fragment, type VNode } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type { PaletteColor } from './palette.ts'
import type { Actor, UnknownActor } from './value-types.ts'

/**
 * D18's four states, plus `not-found` for a 404. A 404 is kept apart from `empty` (the thing
 * exists and has nothing in it) and from `no-permission` (a 403). Hidden things answer 404
 * like missing ones (docs/ROLES.md), so not-found never claims the thing does not exist.
 *
 * Root view blocks add two (D79, D77): `invalid`, a stored block that names a removed or
 * non-indexed attribute or a missing folder, and `unresolved`, a block that depends on another
 * block's item when there is none (no current sprint). Neither is a failure, so neither is an
 * alert. StateBlock re-exports this as `BlockState`.
 */
export type BlockStateName =
  'loading' | 'empty' | 'error' | 'no-permission' | 'not-found' | 'invalid' | 'unresolved'
type BlockState = BlockStateName

/**
 * Presentation pieces for root view blocks (D77). These components know nothing about views,
 * bindings or the API: the block renderer maps a block's config and data onto them.
 */

/** `ready` shows the content; anything else replaces it with that state (D18 plus D79's). */
export type DataBlockState = 'ready' | BlockState

/** Rows and cards show at most 4 fields (D77). */
export const MAX_ROW_FIELDS = 4
/** A list group shows at most 2 measures (D77). */
export const MAX_GROUP_MEASURES = 2

/** One shown value of an item's attribute, already formatted by the renderer. */
export interface FieldValue {
  text: string
  /** The attribute has no value; `text` is the configured empty text ("No epic", "?"). */
  empty?: boolean
  /** A select option's colour, shown as a dot before the text. */
  color?: PaletteColor
  /** IDs and raw values, in JetBrains Mono. */
  mono?: boolean
}

/** A column of row fields in a GroupedList. */
export interface ListField {
  key: string
  /** Read by screen readers before the value ("Epic Notifications"). */
  label: string
  /** Shown before the title, as the mockup's item ID. Otherwise after it. */
  lead?: boolean
  /** Fixed width in px, so the rows line up. Defaults by kind (see `fieldWidth`). */
  width?: number
  align?: 'start' | 'end'
}

export interface ListRow {
  id: string
  title: string
  values: Record<string, FieldValue | undefined>
  /** Opens the item by route. Without it the row is a button that emits `open`. */
  to?: RouteLocationRaw
}

export interface ListGroup {
  id: string
  /** Empty for an ungrouped list: no group header. */
  label: string
  /** Up to 2, already formatted ("19 points", "1 not estimated"). */
  measures?: string[]
  rows: ListRow[]
  /** Rows past the list's limit that are not shown. */
  more?: number
}

export interface BoardCardData {
  id: string
  title: string
  /** Up to 4 card fields, joined with commas ("PT-214, 5 points"). */
  fields: FieldValue[]
  to?: RouteLocationRaw
}

export interface BoardColumnData {
  id: string
  label: string
  color?: PaletteColor
  /** Cards in the column, which can be more than the cards shown. */
  count: number
  cards: BoardCardData[]
  /** Shown in a dashed box when the column has no cards. */
  emptyText?: string
}

export interface BarRow {
  id: string
  label: string
  /** For a row per person: the avatar and name replace the label. */
  actor?: Actor | UnknownActor
  value: number
  max: number
  /** The value in words, always shown ("11 of 12", "10"): the bar is never the only signal. */
  text: string
}

export interface InlineField {
  key: string
  label: string
  value: FieldValue
}

/** The live dot: the hub feed's connection state (D82), mirroring the feed's own statuses. */
export type LiveStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

/** Width of a bar's fill in percent, clamped to 0 to 100. A max of 0 or less draws nothing. */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0
  return Math.min(100, Math.round((value / max) * 1000) / 10)
}

/** The group header's right side: up to 2 measures, comma separated. */
export function measureText(measures: readonly string[] | undefined): string {
  return (measures ?? [])
    .filter((m) => m !== '')
    .slice(0, MAX_GROUP_MEASURES)
    .join(', ')
}

/** Split a list's fields into those before the title and those after, keeping at most 4. */
export function splitFields(fields: readonly ListField[]): {
  lead: ListField[]
  rest: ListField[]
} {
  const shown = fields.slice(0, MAX_ROW_FIELDS)
  return { lead: shown.filter((f) => f.lead), rest: shown.filter((f) => !f.lead) }
}

/** Default widths from the backlog mockup: IDs and short values 52px, numbers 24px, text 110px. */
export function fieldWidth(field: ListField, value?: FieldValue): number {
  if (field.width !== undefined) return field.width
  if (field.align === 'end') return 24
  if (field.lead || value?.mono) return 52
  return 110
}

/** The summary row's trailing text ("In progress, Sara"). Empty values keep their empty text. */
export function joinFields(values: readonly (FieldValue | undefined)[]): string {
  return values
    .filter((v): v is FieldValue => v !== undefined && v.text !== '')
    .slice(0, MAX_ROW_FIELDS)
    .map((v) => v.text)
    .join(', ')
}

/** "+12 more" under a list group or a board column cut at its limit. */
export function moreText(more: number | undefined): string {
  return more && more > 0 ? `+${more.toLocaleString('en-US')} more` : ''
}

/** The count beside a board column's name, as screen readers hear it. */
export function countLabel(count: number): string {
  return count === 1 ? '1 item' : `${count.toLocaleString('en-US')} items`
}

/** Short state text for small slots such as a number, where StateBlock's titles are too long. */
export const SHORT_STATE_TEXT: Record<BlockState, string> = {
  loading: 'Loading',
  empty: 'No value',
  error: 'Could not load',
  'no-permission': 'No access',
  'not-found': 'Not available',
  invalid: 'Needs fixing',
  unresolved: 'Nothing to show',
}

/** Default text for a whole block's states, shown by StateBlock's compact size. */
export const BLOCK_STATE_TEXT: Record<BlockState, { title: string; message: string }> = {
  loading: { title: 'Loading', message: '' },
  empty: { title: 'Nothing here yet', message: '' },
  error: { title: 'This block could not load', message: 'Reload the page to try again.' },
  'no-permission': {
    title: 'You do not have access to this',
    message: 'It shows a folder that is not shared with you.',
  },
  'not-found': {
    title: 'This item is not available',
    message: 'It may not exist, or it may not be shared with you.',
  },
  invalid: {
    title: 'This block needs fixing',
    message:
      'It uses an attribute or folder that was removed or is no longer indexed. A hub admin can fix it.',
  },
  unresolved: {
    title: 'Nothing to show yet',
    message: 'It depends on an item that is not there, such as a current sprint.',
  },
}

/**
 * The element children of a slot, with fragments (`v-for`, `<template>`) opened and comments
 * (`v-if` placeholders) dropped, so a layout block can wrap each child in its own cell.
 */
export function slotChildren(nodes: readonly VNode[] | undefined): VNode[] {
  const out: VNode[] = []
  for (const node of nodes ?? []) {
    if (node.type === Comment) continue
    if (node.type === Fragment && Array.isArray(node.children)) {
      out.push(...slotChildren(node.children as VNode[]))
    } else out.push(node)
  }
  return out
}
