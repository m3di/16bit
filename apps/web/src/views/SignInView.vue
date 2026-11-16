<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { asRequestError } from '../api/client.ts'
import { safeNext } from '../session/next.ts'
import { useSession } from '../session/session.ts'
import { AuthLayout, SignInForm, type SignInState } from '../ui/index.ts'

const route = useRoute()
const router = useRouter()
const session = useSession()

const next = computed(() => safeNext(route.query['next']))
const state = ref<SignInState>('idle')
const message = ref('')

// Someone already signed in goes straight on.
onMounted(() => {
  void session.ensure()
})
watch(
  () => session.me.value,
  (me) => {
    if (me.state === 'ready' && me.data && state.value !== 'submitting') {
      void router.replace(next.value)
    }
  },
  { immediate: true },
)

async function submit(credentials: { email: string; password: string }) {
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
    const e = asRequestError(error)
    state.value = 'error'
    // A malformed email gets the same answer as a wrong password: the form never says which.
    message.value =
      e.code === 'unauthorized' || e.code === 'invalid_request'
        ? ''
        : e.code === 'rate_limited'
          ? 'Too many attempts. Wait a few minutes, then try again.'
          : e.message
  }
}
</script>

<template>
  <AuthLayout title="Sign in">
    <SignInForm :state="state" :message="message" @submit="submit" />
    <template #footer>
      <p class="m-0">
        No account yet? Ask an owner or admin of your workspace for an invite. A forgotten password
        is reset by whoever runs this installation.
      </p>
    </template>
  </AuthLayout>
</template>
