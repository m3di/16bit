<script setup lang="ts">
import { onMounted } from 'vue'
import { useSession } from '../../session/session.ts'
import MembersPage from './MembersPage.vue'
import { useWorkspaceMembers } from './useWorkspaceMembers.ts'

const { workspaceId } = defineProps<{ workspaceId: string }>()

const origin = window.location.origin
const session = useSession()
const model = useWorkspaceMembers(
  workspaceId,
  () => (session.me.value.state === 'ready' ? session.me.value.data : null),
  (...args) => fetch(...args),
  // A change to the reader's own role or membership: read the session again.
  () => session.load(),
)

onMounted(async () => {
  // The reader's role comes from the session, so it is known before the lists load.
  await session.ensure()
  await model.load()
})
</script>

<template>
  <MembersPage :workspace-id="workspaceId" :model="model" :me="session.me.value" :origin="origin" />
</template>
