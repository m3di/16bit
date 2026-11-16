import type { Router } from 'vue-router'
import { setUnauthorizedHandler } from '../api/client.ts'
import type { Session } from './session.ts'

/**
 * Sends the reader to sign-in when the API answers 401: the session ended or never existed.
 * The page they were on comes back as `next`. Public pages (sign-in, invites) handle their own.
 */
export function installAuthRedirect(router: Router, session: Session): () => void {
  return setUnauthorizedHandler(() => {
    session.expire()
    const current = router.currentRoute.value
    if (current.meta.public) return
    void router.replace({ name: 'sign-in', query: { next: current.fullPath } })
  })
}
