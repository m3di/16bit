import type { LoginRequest } from '@16bit/core'
import { computed, ref, watch } from 'vue'
import type { Router } from 'vue-router'
import { asRequestError, type ApiRequestError } from '../api/client.ts'
import { safeNext } from './next.ts'
import type { Session } from './session.ts'

export type SignInFormState = 'idle' | 'submitting' | 'error'

/**
 * The form's message for a refused sign-in. Empty means the form's own default ("wrong email or
 * password"). A malformed email gets the same answer as a wrong password: the form never says
 * which.
 */
export function signInMessage(error: ApiRequestError): string {
  if (error.code === 'unauthorized' || error.code === 'invalid_request') return ''
  if (error.code === 'rate_limited') return 'Too many attempts. Wait a few minutes, then try again.'
  return error.message
}

/**
 * The sign-in page's logic: submit, and send someone already signed in straight on to `next`.
 * Call inside a component setup or an effect scope (it installs a watcher).
 */
export function useSignIn(session: Session, router: Router) {
  const next = computed(() => safeNext(router.currentRoute.value.query['next']))
  const state = ref<SignInFormState>('idle')
  const message = ref('')

  watch(
    () => session.me.value,
    (me) => {
      if (me.state === 'ready' && me.data && state.value !== 'submitting') {
        void router.replace(next.value)
      }
    },
    { immediate: true },
  )

  async function submit(credentials: LoginRequest): Promise<void> {
    if (!credentials.email || !credentials.password) {
      state.value = 'error'
      message.value = 'Enter your email and password.'
      return
    }
    state.value = 'submitting'
    message.value = ''
    try {
      await session.signIn(credentials)
      await router.replace(next.value)
    } catch (error) {
      state.value = 'error'
      message.value = signInMessage(asRequestError(error))
    }
  }

  return { next, state, message, submit }
}
