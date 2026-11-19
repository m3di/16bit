import {
  MAX_EXPAND_ATTRIBUTES,
  MAX_HIDDEN_BACKLINKS,
  type FolderAttributeDefinition,
  type HubDescription,
  type Item,
} from '@16bit/core'
import type { RouteLocationRaw } from 'vue-router'
import type { ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

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
