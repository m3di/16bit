<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { asRequestError } from '../api/client.ts'
import { ActorChip, BaseButton } from '../ui/index.ts'
import { useSession } from './session.ts'

// The signed-in user in the shell's top bar, with sign-out.

const session = useSession()
const me = session.me
const route = useRoute()
const router = useRouter()

onMounted(() => {
  void session.ensure()
})

const actor = computed(() => {
  const value = me.value
  if (value.state !== 'ready' || !value.data) return null
  // The account is the same person in every workspace, so its ID draws the avatar here.
  return value.data.kind === 'person'
    ? { id: value.data.account.id, name: value.data.account.name, kind: 'person' as const }
    : { id: value.data.principalId, name: value.data.hub.name, kind: 'agent' as const }
})

const busy = ref(false)
const error = ref('')
async function signOut() {
  busy.value = true
  error.value = ''
  try {
    await session.signOut()
    await router.push({ name: 'sign-in' })
  } catch (e) {
    error.value = `Sign-out failed. ${asRequestError(e).message}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-2" data-shell-user>
    <ActorChip v-if="me.state === 'loading'" :actor="null" state="loading" />
    <ActorChip v-else-if="me.state === 'error'" :actor="null" state="error" />
    <template v-else-if="actor">
      <ActorChip :actor="actor" />
      <BaseButton size="sm" variant="quiet" :disabled="busy" @click="signOut">
        {{ busy ? 'Signing out' : 'Sign out' }}
      </BaseButton>
    </template>
    <RouterLink
      v-else
      :to="{ name: 'sign-in', query: { next: route.fullPath } }"
      class="border-b border-line2 text-ink no-underline hover:border-line3"
      >Sign in</RouterLink
    >
    <span v-if="error" role="alert" class="basis-full text-secondary text-danger">{{ error }}</span>
  </div>
</template>
