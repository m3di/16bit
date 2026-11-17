<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import FormNotice from './FormNotice.vue'

import type { SignInState } from './value-types.ts'

const {
  state = 'idle',
  message = '',
  initialEmail = '',
} = defineProps<{
  /**
   * idle: the empty form. submitting: the loading state, inputs locked. error: wrong email or
   * password, or the server failed; `message` says which. no-permission: signed in but the
   * account may not enter (no membership, disabled); `message` says why.
   */
  state?: SignInState
  message?: string
  initialEmail?: string
}>()

const emit = defineEmits<{ submit: [credentials: { email: string; password: string }] }>()

const email = ref(initialEmail)
const password = ref('')
const busy = computed(() => state === 'submitting')

const defaults: Record<'error' | 'no-permission', string> = {
  // Never says which of the two was wrong (M1-03: login does not reveal whether an email exists).
  error: 'That email and password do not match.',
  'no-permission': 'This account cannot sign in here. Ask an owner or admin for an invite.',
}
const notice = computed(() =>
  state === 'error' || state === 'no-permission' ? message || defaults[state] : '',
)

function submit() {
  if (busy.value) return
  emit('submit', { email: email.value.trim(), password: password.value })
}
</script>

<template>
  <form
    class="flex flex-col gap-4"
    novalidate
    :aria-busy="busy ? 'true' : undefined"
    :data-state="state"
    @submit.prevent="submit"
  >
    <FormNotice v-if="notice" :tone="state === 'error' ? 'error' : 'info'">{{ notice }}</FormNotice>
    <BaseInput
      v-model="email"
      label="Email"
      type="email"
      name="email"
      autocomplete="username"
      required
      :disabled="busy"
    />
    <BaseInput
      v-model="password"
      label="Password"
      type="password"
      name="password"
      autocomplete="current-password"
      required
      :disabled="busy"
    />
    <BaseButton variant="primary" type="submit" :disabled="busy">
      {{ busy ? 'Signing in' : 'Sign in' }}
    </BaseButton>
    <span v-if="busy" role="status" class="sr-only">Signing in</span>
  </form>
</template>
