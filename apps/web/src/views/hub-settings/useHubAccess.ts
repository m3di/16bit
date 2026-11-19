import {
  agentKeyPageSchema,
  agentKeySchema,
  createdAgentKeySchema,
  hubGrantPageSchema,
  hubGrantSchema,
  memberPageSchema,
  type AgentHubRole,
  type AgentKey,
  type CreatedAgentKey,
  type HubGrantEntry,
  type HubRole,
  type Principal,
} from '@16bit/core'
import { ref } from 'vue'
import {
  asRequestError,
  getAllPages,
  noContent,
  putJson,
  sendJson,
  type ApiRequestError,
  type Fetch,
} from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { HUB_ROLE_LABELS } from './access.ts'

/**
 * Who holds access to a hub (`GET /hubs/:hubId/grants`), the workspace's people to add from
 * (`GET /members`), and the hub's agent keys. Role changes and revokes are optimistic and roll
 * back with a notice when the API refuses them. Adding someone, creating a key and revoking a
 * key wait for the answer inside their dialog, which keeps the reader's input on a refusal.
 */
export function useHubAccess(
  workspaceId: string,
  hubId: string,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
  const ws = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const hubPath = `${ws}/hubs/${encodeURIComponent(hubId)}`
  const grants = ref<Load<HubGrantEntry[]>>({ state: 'loading' })
  const members = ref<Load<Principal[]>>({ state: 'loading' })
  const keys = ref<Load<AgentKey[]>>({ state: 'loading' })
  /** Why the last access change was refused, shown above the table until dismissed. */
  const notice = ref<string | null>(null)

  async function into<T>(target: { value: Load<T> }, read: () => Promise<T>, keep = false) {
    if (!(keep && target.value.state === 'ready')) target.value = { state: 'loading' }
    try {
      target.value = { state: 'ready', data: await read() }
    } catch (error) {
      if (!(keep && target.value.state === 'ready')) {
        target.value = { state: 'error', error: asRequestError(error) }
      }
    }
  }

  const loadGrants = (keep = false) =>
    into(grants, () => getAllPages(`${hubPath}/grants`, hubGrantPageSchema, fetchFn), keep)
  const loadMembers = () =>
    into(members, () => getAllPages(`${ws}/members`, memberPageSchema, fetchFn))
  const loadKeys = () =>
    into(keys, () => getAllPages(`${hubPath}/agent-keys`, agentKeyPageSchema, fetchFn))

  const grantList = () => (grants.value.state === 'ready' ? grants.value.data : null)

  const fail = (what: string, error: ApiRequestError) =>
    `${what} ${
      error.isNoPermission
        ? 'Your role does not allow this.'
        : error.code === 'network'
          ? 'The server could not be reached.'
          : error.message
    }`

  // The last hub role each principal is known to hold, and the latest request per principal,
  // so an older answer arriving late never overwrites a newer choice.
  const confirmed = new Map<string, HubRole>()
  const latest = new Map<string, number>()
  let seq = 0

  /** Shows the new role at once, then asks the API. A refusal puts the last known role back. */
  async function changeRole(principalId: string, hubRole: HubRole): Promise<boolean> {
    const row = grantList()?.find((g) => g.principalId === principalId)
    if (!row || row.hubRole === hubRole) return true
    if (!confirmed.has(principalId)) confirmed.set(principalId, row.hubRole)
    const mine = ++seq
    latest.set(principalId, mine)
    row.hubRole = hubRole
    notice.value = null
    try {
      const saved = await putJson(
        `${hubPath}/grants/${encodeURIComponent(principalId)}`,
        { hubRole },
        hubGrantSchema,
        fetchFn,
      )
      confirmed.set(principalId, saved.hubRole)
      if (latest.get(principalId) === mine) {
        row.hubRole = saved.hubRole
        confirmed.delete(principalId)
      }
      return true
    } catch (raw) {
      const error = asRequestError(raw)
      if (latest.get(principalId) !== mine) return false
      row.hubRole = confirmed.get(principalId) ?? row.hubRole
      confirmed.delete(principalId)
      notice.value = fail(
        `${row.name}'s access was not changed to ${HUB_ROLE_LABELS[hubRole]}.`,
        error,
      )
      // The roles here are not what the page thought: read them again.
      if (!error.isUnauthorized && (error.isNoPermission || error.isNotFound)) {
        void loadGrants(true)
      }
      return false
    }
  }

  /** Removes the row at once; a refusal puts it back where it was. */
  async function revoke(principalId: string): Promise<boolean> {
    const list = grantList()
    const at = list?.findIndex((g) => g.principalId === principalId) ?? -1
    const row = list?.[at]
    if (!list || !row) return true
    list.splice(at, 1)
    notice.value = null
    try {
      await sendJson(
        'DELETE',
        `${hubPath}/grants/${encodeURIComponent(principalId)}`,
        undefined,
        noContent,
        fetchFn,
      )
      return true
    } catch (raw) {
      const error = asRequestError(raw)
      const now = grantList()
      if (now && !now.some((g) => g.principalId === principalId)) {
        now.splice(Math.min(at, now.length), 0, row)
      }
      notice.value = fail(`${row.name}'s access was not revoked.`, error)
      if (!error.isUnauthorized && (error.isNoPermission || error.isNotFound)) {
        void loadGrants(true)
      }
      return false
    }
  }

  /** Grants a person access. Throws the request error for the dialog. */
  async function add(person: Principal, hubRole: HubRole): Promise<void> {
    const saved = await putJson(
      `${hubPath}/grants/${encodeURIComponent(person.id)}`,
      { hubRole },
      hubGrantSchema,
      fetchFn,
    )
    const list = grantList()
    if (!list) return
    const entry: HubGrantEntry = {
      principalId: person.id,
      // Only people are added here; an agent's grant comes with its key (D47).
      kind: 'user',
      name: person.name,
      workspaceRole: person.workspaceRole,
      hubRole: saved.hubRole,
    }
    const at = list.findIndex((g) => g.principalId === person.id)
    if (at === -1) list.push(entry)
    else list[at] = entry
    list.sort((a, b) =>
      a.name === b.name ? a.principalId.localeCompare(b.principalId) : a.name < b.name ? -1 : 1,
    )
  }

  /** Creates a key. Throws the request error for the dialog. The secret is shown once. */
  async function createKey(input: {
    name: string
    hubRole: AgentHubRole
    expiresAt: string | null
  }): Promise<CreatedAgentKey> {
    const created = await sendJson(
      'POST',
      `${hubPath}/agent-keys`,
      input,
      createdAgentKeySchema,
      fetchFn,
    )
    if (keys.value.state === 'ready') keys.value.data.unshift(created.key)
    // The key's principal now holds a grant on this hub.
    void loadGrants(true)
    return created
  }

  /** Revokes a key after the reader confirmed it. Throws the request error for the dialog. */
  async function revokeKey(keyId: string): Promise<AgentKey> {
    const saved = await sendJson(
      'POST',
      `${ws}/agent-keys/${encodeURIComponent(keyId)}/revoke`,
      {},
      agentKeySchema,
      fetchFn,
    )
    if (keys.value.state === 'ready') {
      const at = keys.value.data.findIndex((k) => k.id === keyId)
      if (at !== -1) keys.value.data[at] = saved
    }
    // The agent keeps its grant; the access list marks it revoked.
    if (grants.value.state === 'ready') {
      const g = grants.value.data.find((x) => x.principalId === keyId)
      if (g?.kind === 'agent') g.keyState = 'revoked'
    }
    return saved
  }

  function dismissNotice() {
    notice.value = null
  }

  return {
    grants,
    members,
    keys,
    notice,
    loadGrants,
    loadMembers,
    loadKeys,
    changeRole,
    revoke,
    add,
    createKey,
    revokeKey,
    dismissNotice,
  }
}

export type HubAccess = ReturnType<typeof useHubAccess>
