import {
  idSchema,
  MAX_EXPAND_ATTRIBUTES,
  MAX_HIDDEN_BACKLINKS,
  type FolderAttributeDefinition,
  type HubDescription,
  type Item,
} from '@16bit/core'
import type { RouteLocationRaw } from 'vue-router'
import { ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

/**
 * An item's title: its value for the hub's title attribute (D50), trimmed. `''` when the hub
 * names none or the value is empty; the page then shows only the item's mono ID.
 */
export function pageTitle(item: Item, hub: HubDescription): string {
  const id = hub.hub.titleAttributeId
  const value = id ? item.values[id] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/** The relation attributes of the item's folder that its read expands, in position order. */
export const expandFor = (columns: readonly FolderAttributeDefinition[]): string[] =>
  columns
    .filter((c) => c.attribute.type === 'relation')
    .slice(0, MAX_EXPAND_ATTRIBUTES)
    .map((c) => c.attribute.id)

/** The folder an item is in, or `null` when the hub description does not list it (truncated). */
export function itemFolder(hub: HubDescription, item: Item) {
  if (item.folderId === hub.hub.id) return hub.hub
  return hub.folders.find((f) => f.id === item.folderId) ?? null
}

/** Where an item's own page is. */
export const itemPageLink = (workspaceId: string, item: Pick<Item, 'id'>): RouteLocationRaw => ({
  name: 'item',
  params: { workspaceId, itemId: item.id },
})

/** Where an item's folder opens in its hub, with the item selected in the table. */
export const folderLink = (workspaceId: string, item: Item): RouteLocationRaw => ({
  name: 'hub',
  params: {
    workspaceId,
    hubId: item.hubId,
    ...(item.folderId === item.hubId ? {} : { folderId: item.folderId }),
  },
})

/**
 * How many links come from items the reader cannot see, or `''` for none. The server counts up
 * to `MAX_HIDDEN_BACKLINKS` and never says which items they are (docs/ROLES.md).
 */
export function hiddenNote(hidden: number): string {
  if (hidden <= 0) return ''
  if (hidden >= MAX_HIDDEN_BACKLINKS) {
    return `${new Intl.NumberFormat('en').format(MAX_HIDDEN_BACKLINKS)} or more links from items you cannot see.`
  }
  return hidden === 1
    ? '1 link from an item you cannot see.'
    : `${String(hidden)} links from items you cannot see.`
}

export type PageState =
  | { state: 'loading' }
  | { state: 'error' | 'no-permission' | 'not-found'; error: ApiRequestError }
  | { state: 'ready'; item: Item; hub: HubDescription }

/**
 * The page's state from the item read, then its hub's description. A hidden item answers 404
 * like a missing one (D45), so both are "not found". The hub of a readable item is readable,
 * so any failure there is an error to retry.
 */
export function pageState(item: Load<Item>, hub: Load<HubDescription> | null): PageState {
  if (item.state === 'loading') return item
  if (item.state === 'error') {
    if (item.error.isNotFound) return { state: 'not-found', error: item.error }
    if (item.error.isNoPermission) return { state: 'no-permission', error: item.error }
    return { state: 'error', error: item.error }
  }
  if (!hub || hub.state === 'loading') return { state: 'loading' }
  if (hub.state === 'error') return { state: 'error', error: hub.error }
  return { state: 'ready', item: item.data, hub: hub.data }
}

/**
 * A not-found load for an ID the API could never accept (outside `idSchema`), so the page shows
 * "not available" without a request and without a retry that cannot work. `null` for a valid ID.
 */
export function malformedItemId(id: string): Load<Item> | null {
  if (idSchema.safeParse(id).success) return null
  return {
    state: 'error',
    error: new ApiRequestError('not_found', 'This item is not available.', 404),
  }
}

/**
 * The item after its second read (with `expand`). If it went missing or out of reach between
 * the two reads, that answer wins, so the page does not show the first copy as live. Any other
 * failure keeps the first copy: the editors then read linked items one by one.
 */
export function afterExpandRead(first: Load<Item>, second: Load<Item>): Load<Item> {
  if (second.state === 'error' && (second.error.isNotFound || second.error.isNoPermission)) {
    return second
  }
  return first
}
