import type { Block } from '@16bit/core'
import { inject, provide, type InjectionKey } from 'vue'
import type { BlockLoad } from './useRootView.ts'

/** What blocks read from the page around them. */
export interface RootViewContext {
  /** A data block's data; `undefined` before the page asked for it. */
  load(blockId: string): BlockLoad | undefined
  /** A name for a data block that has no title of its own: its label, else its folder's name. */
  nameOf(block: Block): string
}

const key: InjectionKey<RootViewContext> = Symbol('root view')

export const provideRootView = (context: RootViewContext) => {
  provide(key, context)
}

const none: RootViewContext = { load: () => undefined, nameOf: () => 'Items' }

export const useRootViewContext = (): RootViewContext => inject(key, none)
