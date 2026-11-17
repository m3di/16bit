<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSession } from '../session/session.ts'
import { useSignIn } from '../session/sign-in.ts'
import { AuthLayout, SignInForm } from '../ui/index.ts'

const session = useSession()
// Submits, and sends someone already signed in straight on to `next`.
const { state, message, submit } = useSignIn(session, useRouter())

onMounted(() => {
  void session.ensure()
})
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
