import {
  acceptedInviteSchema,
  meSchema,
  type AcceptedInvite,
  type AcceptInvite,
  type LoginRequest,
  type Me,
} from '@16bit/core'
import { inject, ref, type InjectionKey } from 'vue'
import { asRequestError, getJson, noContent, sendJson, type Fetch } from '../api/client.ts'
import type { Load } from '../views/home/useDashboard.ts'

const quiet = { quiet401: true }

/**
 * Who is signed in, from `GET /v1/me`. `null` means signed out. With the development proxy key
 * (until #51) the data routes answer while `/v1/me` says 401, so the dashboard still works and
 * the shell offers sign-in.
 */
export function createSession(fetchFn: Fetch = (...args) => fetch(...args)) {
  const me = ref<Load<Me | null>>({ state: 'loading' })
  let loading: Promise<void> | null = null

  async function fetchMe() {
    try {
      const data = await getJson('/v1/me', meSchema, fetchFn, quiet)
      me.value = { state: 'ready', data }
    } catch (error) {
      const e = asRequestError(error)
      me.value = e.isUnauthorized ? { state: 'ready', data: null } : { state: 'error', error: e }
    }
  }

  /** Loads the current user. A second call while one runs joins it. */
  function load(): Promise<void> {
    loading ??= fetchMe().finally(() => {
      loading = null
    })
    return loading
  }

  /** Loads the current user unless that is already known. */
  function ensure(): Promise<void> {
    return me.value.state === 'ready' ? Promise.resolve() : load()
  }

  /** Throws an `ApiRequestError` on failure: 401 for a wrong email or password. */
  async function signIn(credentials: LoginRequest): Promise<Me> {
    const data = await sendJson('POST', '/v1/auth/login', credentials, meSchema, fetchFn, quiet)
    me.value = { state: 'ready', data }
    return data
  }

  /** Ends the session on the server first: the cookie is httpOnly, so only the API can clear it. */
  async function signOut(): Promise<void> {
    await sendJson('POST', '/v1/auth/logout', {}, noContent, fetchFn, quiet)
    me.value = { state: 'ready', data: null }
  }

  /** A new account (which is then signed in), or `{}` to add the signed-in account. */
  async function acceptInvite(token: string, body: AcceptInvite): Promise<AcceptedInvite> {
    const path = `/v1/auth/invites/${encodeURIComponent(token)}`
    const accepted = await sendJson('POST', path, body, acceptedInviteSchema, fetchFn, quiet)
    // The account now has another workspace, and a new account is now signed in.
    await load()
    return accepted
  }

  /** The session ended (a 401 elsewhere). */
  function expire() {
    me.value = { state: 'ready', data: null }
  }

  return { me, load, ensure, signIn, signOut, acceptInvite, expire }
}

export type Session = ReturnType<typeof createSession>

export const sessionKey: InjectionKey<Session> = Symbol('session')

/** The app's session, provided in `main.ts`. A missing provider is a bug, not a second session. */
export function useSession(): Session {
  const session = inject(sessionKey, null)
  if (!session) throw new Error('useSession() needs a session provided with sessionKey')
  return session
}
