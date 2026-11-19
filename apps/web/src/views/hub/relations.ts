import type { HubDescription, Item, LinkedItem } from '@16bit/core'
import type { RelationTarget } from '../../ui/index.ts'
import { folderColumns } from './useHub.ts'

/**
 * What the dashboard knows about one linked item ID.
 * - `read`/`none`: as the server sent it (`linked` of a query, or a direct read).
 * - `gone`: an expanded query left it out, so it no longer exists (see `itemQueryResultSchema`).
 * - `error`: a direct read failed for another reason than 404.
 * - `unknown`: not asked yet.
 */
export type LinkedState =
  LinkedItem | { access: 'gone' } | { access: 'error' } | { access: 'unknown' }

/** How one relation chip is drawn. `null` hides it (the linked item was deleted). */
export type ChipView =
  | { state: 'ready'; target: RelationTarget; item: Item | null }
  | { state: 'loading' | 'error' }
  | null

/**
 * The title of an item: its value for the hub's title attribute (D50), trimmed. `''` when the
 * hub names none or the value is empty; the item then shows only its mono ID. Every place that
 * titles an item uses this: relation chips, the relation picker and the item page.
 */
export function itemTitle(item: Item, hub: HubDescription): string {
  const id = hub.hub.titleAttributeId
  const value = id ? item.values[id] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The hub's title attribute when `folderId` shows it, else `null`. The relation picker searches
 * it on the server (`contains`) when it is indexed, and among the loaded items otherwise.
 */
export function titleAttribute(hub: HubDescription, folderId: string) {
  const id = hub.hub.titleAttributeId
  if (!id) return null
  return folderColumns(hub, folderId).find((c) => c.attribute.id === id)?.attribute ?? null
}

/** `BLD-12` for an item, given its hub. */
export const displayId = (hub: HubDescription, item: Item) =>
  `${hub.hub.idPrefix}-${String(item.seqId)}`

/**
 * A readable linked item as a chip: its display ID and title. Without a title the display ID
 * becomes the link text, so the chip is never empty.
 */
export function readableTarget(item: Item, hub: HubDescription): RelationTarget {
  const id = displayId(hub, item)
  const title = itemTitle(item, hub)
  return title
    ? { access: 'ok', id: item.id, title, displayId: id }
    : { access: 'ok', id: item.id, title: id }
}

/**
 * The chip for one linked ID. `hubOf` returns the description of a hub the reader can see,
 * `'loading'` while it is on its way, and `'error'` if it could not be read.
 */
export function chipView(
  id: string,
  state: LinkedState,
  hubOf: (hubId: string) => HubDescription | 'loading' | 'error',
): ChipView {
  switch (state.access) {
    case 'gone':
      return null
    case 'unknown':
      return { state: 'loading' }
    case 'error':
      return { state: 'error' }
    case 'none':
      return { state: 'ready', target: { access: 'none', id }, item: null }
    case 'read': {
      const hub = hubOf(state.item.hubId)
      if (hub === 'loading' || hub === 'error') return { state: hub }
      return { state: 'ready', target: readableTarget(state.item, hub), item: state.item }
    }
  }
}

/** A relation, actor or multi-select value as a list. Anything else is an empty list. */
export const listValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * `list` with `id` added or removed. An empty list becomes `null`, which is how the server
 * stores it. With `multiple` off, adding replaces the value.
 */
export function toggled(
  list: readonly string[],
  id: string,
  on: boolean,
  multiple = true,
): string[] | null {
  const without = list.filter((v) => v !== id)
  const next = on ? (multiple ? [...without, id] : [id]) : without
  return next.length > 0 ? next : null
}

/**
 * A multi-select value after ticking or unticking `id`. IDs of deleted options are dropped
 * from every commit: core refuses unknown IDs, so keeping one would block every edit.
 */
export function multiSelectToggled(
  value: readonly string[],
  options: readonly { id: string }[],
  id: string,
  on: boolean,
): string[] | null {
  const live = new Set(options.map((o) => o.id))
  const next = (toggled(value, id, on) ?? []).filter((v) => live.has(v))
  return next.length > 0 ? next : null
}

/**
 * Whether the picker says its matches come only from the loaded pages. Only above a list of
 * matches: with none, the "No matches among the items loaded so far" line says it instead.
 */
export const showsLoadedOnlyNote = (local: boolean, searched: string, offered: number) =>
  local && searched !== '' && offered > 0
