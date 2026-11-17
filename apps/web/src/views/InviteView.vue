<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PASSWORD_MIN_LENGTH } from '@16bit/core'
import { asRequestError } from '../api/client.ts'
import {
  acceptInvite,
  isInviteToken,
  newAccountErrors,
  type InviteOutcome,
} from '../session/invite.ts'
import { useSession } from '../session/session.ts'
import {
  ActorChip,
  AuthLayout,
  BaseButton,
  BaseInput,
  FormNotice,
  StateBlock,
} from '../ui/index.ts'

// Two ways in: a new account sets a password and is signed in, or a signed-in account joins
// with one click. Someone with an account who is signed out signs in first and comes back.

const route = useRoute()
const router = useRouter()
const session = useSession()
const me = session.me

const token = computed(() =>
  typeof route.params['token'] === 'string' ? route.params['token'] : '',
)
const valid = computed(() => isInviteToken(token.value))
const signInLink = computed(() => ({ name: 'sign-in', query: { next: route.fullPath } }))

const busy = ref(false)
const outcome = ref<InviteOutcome | null>(null)
const form = reactive({ name: '', email: '', password: '' })
const fieldErrors = ref<ReturnType<typeof newAccountErrors>>({})

onMounted(() => {
  if (valid.value) void session.ensure()
})

const title = computed(() => {
  if (!valid.value || outcome.value?.kind === 'not-found') return 'This invite is not valid'
  if (outcome.value?.kind === 'already-member') return 'You are already a member'
  return 'Accept your invite'
})

async function accept(body: Parameters<typeof session.acceptInvite>[1]) {
  busy.value = true
  outcome.value = null
  try {
    outcome.value = await acceptInvite(session, router, token.value, body)
  } finally {
    busy.value = false
  }
}

function createAccount() {
  if (busy.value) return
  fieldErrors.value = newAccountErrors(form)
  if (Object.keys(fieldErrors.value).length > 0) return
  void accept({ name: form.name.trim(), email: form.email.trim(), password: form.password })
}

const signingOut = ref(false)
const signOutError = ref('')
async function signOut() {
  signingOut.value = true
  signOutError.value = ''
  try {
    await session.signOut()
    outcome.value = null
  } catch (error) {
    signOutError.value = `You are still signed in. ${asRequestError(error).message}`
  } finally {
    signingOut.value = false
  }
}

const passwordHint = `At least ${String(PASSWORD_MIN_LENGTH)} characters.`
const linkClass = 'border-b border-line2 text-ink no-underline hover:border-line3'
</script>

<template>
  <AuthLayout :title="title">
    <template v-if="!valid || outcome?.kind === 'not-found'">
      <p class="m-0 text-ink2" data-invite="not-found">
        It may have been used already, or it may have expired. Ask whoever invited you for a new
        link.
      </p>
    </template>

    <template v-else-if="outcome?.kind === 'already-member'">
      <p class="m-0 text-ink2" data-invite="already-member">
        This account already belongs to the workspace, so the invite was not used.
      </p>
      <RouterLink to="/" :class="linkClass" class="self-start">Go to your workspaces</RouterLink>
    </template>

    <StateBlock v-else-if="me.state === 'loading'" state="loading" title="Checking your session" />
    <StateBlock
      v-else-if="me.state === 'error'"
      state="error"
      title="Your session could not be checked"
      :message="me.error.message"
    >
      <template #action>
        <BaseButton size="sm" @click="session.load()">Try again</BaseButton>
      </template>
    </StateBlock>

    <StateBlock
      v-else-if="me.data?.kind === 'agent'"
      state="no-permission"
      title="An agent key cannot accept an invite"
    />

    <!-- Signed in: join as this account. -->
    <form
      v-else-if="me.data"
      class="flex flex-col gap-4"
      data-invite="existing-account"
      :aria-busy="busy ? 'true' : undefined"
      @submit.prevent="accept({})"
    >
      <p class="m-0 text-ink2">Join the workspace with the account you are signed in with.</p>
      <div class="flex min-w-0 flex-col gap-1">
        <ActorChip
          :actor="{ id: me.data.account.id, name: me.data.account.name, kind: 'person' }"
        />
        <span class="truncate text-secondary text-ink3">{{ me.data.account.email }}</span>
      </div>
      <FormNotice v-if="outcome?.kind === 'error'">
        The invite was not accepted. {{ outcome.message }}
      </FormNotice>
      <BaseButton variant="primary" type="submit" :disabled="busy">
        {{ busy ? 'Accepting' : 'Accept invite' }}
      </BaseButton>
      <span v-if="busy" role="status" class="sr-only">Accepting the invite</span>
    </form>

    <!-- Signed out: a new account, or sign in first. -->
    <form
      v-else
      class="flex flex-col gap-4"
      novalidate
      data-invite="new-account"
      :aria-busy="busy ? 'true' : undefined"
      @submit.prevent="createAccount"
    >
      <p class="m-0 text-ink2">Create your account to join the workspace.</p>
      <FormNotice v-if="outcome?.kind === 'email-taken'">
        An account with this email exists.
        <RouterLink :to="signInLink" :class="linkClass">Sign in to accept the invite</RouterLink>.
      </FormNotice>
      <FormNotice v-else-if="outcome?.kind === 'error'">
        The invite was not accepted. {{ outcome.message }}
      </FormNotice>
      <BaseInput
        v-model="form.name"
        label="Name"
        name="name"
        autocomplete="name"
        required
        :error="fieldErrors.name"
        :disabled="busy"
      />
      <BaseInput
        v-model="form.email"
        label="Email"
        type="email"
        name="email"
        autocomplete="email"
        required
        :error="fieldErrors.email"
        :disabled="busy"
      />
      <BaseInput
        v-model="form.password"
        label="Password"
        type="password"
        name="password"
        autocomplete="new-password"
        :hint="passwordHint"
        required
        :error="fieldErrors.password"
        :disabled="busy"
      />
      <BaseButton variant="primary" type="submit" :disabled="busy">
        {{ busy ? 'Creating your account' : 'Create account and join' }}
      </BaseButton>
      <span v-if="busy" role="status" class="sr-only">Creating your account</span>
    </form>

    <template #footer>
      <div
        v-if="valid && me.state === 'ready' && me.data?.kind === 'person'"
        class="flex flex-col gap-2"
      >
        <p class="m-0">
          Not you?
          <button
            type="button"
            :class="linkClass"
            class="cursor-pointer border-x-0 border-t-0 bg-transparent p-0 text-secondary"
            :disabled="signingOut"
            @click="signOut"
          >
            Sign out
          </button>
          to accept with another account.
        </p>
        <FormNotice v-if="signOutError">{{ signOutError }}</FormNotice>
      </div>
      <p v-else-if="valid && me.state === 'ready' && !me.data" class="m-0">
        Already have an account?
        <RouterLink :to="signInLink" :class="linkClass">Sign in to accept</RouterLink>.
      </p>
      <p v-else class="m-0">
        <RouterLink to="/" :class="linkClass">Go to your workspaces</RouterLink>
      </p>
    </template>
  </AuthLayout>
</template>
