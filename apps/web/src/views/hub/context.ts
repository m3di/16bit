import type { HubDescription, Item } from '@16bit/core'
import { inject, provide, type InjectionKey } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type { Fetch } from '../../api/client.ts'
import type { Actor } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import type { MembersState } from './usePrincipals.ts'
import type { LinkedState } from './relations.ts'

/**
 * What value cells and editors need from the hub page: names for actors, linked items for
 * relations, and the hubs those live in. Provided by `HubPage`; tests provide their own.
 */
export interface ValueContext {
  workspaceId: string
  fetchFn: Fetch
  actor: (id: string) => Actor & { known: boolean }
  actorChoices: () => readonly Actor[]
  members: () => MembersState
  retryMembers: () => void
  linkState: (id: string) => LinkedState
  resolveLinked: (ids: Iterable<string>) => void
  rememberLinked: (item: Item) => void
  hub: (hubId: string) => Load<HubDescription>
  hubLookup: (hubId: string) => HubDescription | 'loading' | 'error'
  ensureHubs: (ids: Iterable<string>) => void
  retryHub: (hubId: string) => void
  /** Where a linked item opens. */
  itemLink: (item: Item) => RouteLocationRaw
}

const key: InjectionKey<ValueContext> = Symbol('value-context')

export const provideValueContext = (context: ValueContext) => {
  provide(key, context)
}

export function useValueContext(): ValueContext {
  const context = inject(key, null)
  if (!context) throw new Error('useValueContext() needs provideValueContext() in a parent')
  return context
}
