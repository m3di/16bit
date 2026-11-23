import type { HubDescription, Item, ItemValues } from '@16bit/core'
import { inject, provide, type InjectionKey } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

/**
 * What data blocks need from the page that shows the view: the hub, the store's copy of each
 * item (so rows update in place, D60), where an item opens, and "New item" (D77).
 */
export interface ViewHost {
  description: () => HubDescription | null
  /** The item as the store shows it now; `undefined` once it is gone. */
  current: (item: Item) => Item | undefined
  /** Where an item opens: the same page with its panel (`?item=`). */
  itemLink: (item: Item) => RouteLocationRaw
  /** "New item" is offered: the reader has `item.write` here and the folder holds items. */
  canCreate: (folderId: string) => boolean
  /** Opens the new-item form for `folderId`, with these values already filled in. */
  create: (folderId: string, values: ItemValues) => void
  /** The reader's principal ID in this workspace, for `$me` presets. */
  me: () => string | null
}

const key: InjectionKey<ViewHost> = Symbol('view host')

export const provideViewHost = (host: ViewHost) => {
  provide(key, host)
}

const none: ViewHost = {
  description: () => null,
  current: (item) => item,
  itemLink: (item) => ({ query: { item: item.id } }),
  canCreate: () => false,
  create: () => undefined,
  me: () => null,
}

export const useViewHost = (): ViewHost => inject(key, none)
