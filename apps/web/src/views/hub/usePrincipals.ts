import { pageSchema, principalSchema, type Me, type Principal } from '@16bit/core'
import { computed, ref } from 'vue'
import { asRequestError, getAllPages, type ApiRequestError, type Fetch } from '../../api/client.ts'
import type { Actor } from '../../ui/index.ts'

/** `GET /v1/workspaces/:w/members` (#43): the people of the workspace. */
const memberPageSchema = pageSchema(principalSchema)

/**
 * Names for actor values. People come from the member list and the signed-in account. The
 * member list arrives with #43; until then, and for agents (who are not in it, #50), an actor
 * shows its avatar and a short ID, never an invented name.
 *
 * - `loading`: the list is on its way.
 * - `ready`: the list was read.
 * - `unavailable`: the server has no member list for this reader (404 or 403). Only the
 *   signed-in user can be named and picked.
 * - `error`: another failure; `retry` reads it again.
 */
export type MembersState =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'unavailable' }
  | { state: 'error'; error: ApiRequestError }

export const shortId = (id: string) => id.slice(0, 8)

export function usePrincipals(
  workspaceId: string,
  me: () => Me | null,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
  const members = ref<Principal[]>([])
  const status = ref<MembersState>({ state: 'loading' })
  let running: Promise<void> | null = null

  async function fetchMembers() {
    status.value = { state: 'loading' }
    try {
      const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/members`
      members.value = await getAllPages(path, memberPageSchema, fetchFn)
      status.value = { state: 'ready' }
    } catch (thrown) {
      const error = asRequestError(thrown)
      status.value =
        error.status === 404 || error.status === 403
          ? { state: 'unavailable' }
          : { state: 'error', error }
    }
  }

  function load(): Promise<void> {
    running ??= fetchMembers().finally(() => {
      running = null
    })
    return running
  }

  /** The signed-in person as an actor in this workspace, if signed in as a person here. */
  const self = computed((): Actor | null => {
    const m = me()
    if (m?.kind !== 'person') return null
    const membership = m.memberships.find((x) => x.workspace.id === workspaceId)
    return membership ? { id: membership.principalId, name: m.account.name, kind: 'person' } : null
  })

  const known = computed(() => {
    const out = new Map<string, Actor>()
    for (const p of members.value) {
      out.set(p.id, { id: p.id, name: p.name, kind: p.kind === 'agent' ? 'agent' : 'person' })
    }
    if (self.value && !out.has(self.value.id)) out.set(self.value.id, self.value)
    return out
  })

  /** An actor by principal ID. One that cannot be named shows a short form of its ID. */
  function actor(id: string): Actor & { known: boolean } {
    const found = known.value.get(id)
    return found
      ? { ...found, known: true }
      : { id, name: shortId(id), kind: 'person', known: false }
  }

  /** Everyone who can be picked, by name. */
  const choices = computed(() =>
    [...known.value.values()].sort((a, b) => a.name.localeCompare(b.name)),
  )

  return { status, members, self, actor, choices, load }
}

export type Principals = ReturnType<typeof usePrincipals>
