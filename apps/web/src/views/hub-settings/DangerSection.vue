<script setup lang="ts">
import type { HubDescription, Subject } from '@16bit/core'
import { computed, onMounted, ref, useId } from 'vue'
import { useRouter } from 'vue-router'
import { BaseButton, ConfirmDialog, SettingsSection } from '../../ui/index.ts'
import { canListGrants, deleteHubState } from './access.ts'
import type { HubAccess } from './useHubAccess.ts'
import type { HubSettings } from './useHubSettings.ts'

const { viewer, description, model, access } = defineProps<{
  viewer: Subject | null
  description: HubDescription
  model: HubSettings
  access: HubAccess
}>()

const router = useRouter()
const reasonId = useId()

// An admin may not delete a hub an owner holds a grant on (D52): the grant list says.
onMounted(() => {
  if (
    viewer?.workspaceRole === 'admin' &&
    canListGrants(viewer, description.hubRole) &&
    access.grants.value.state !== 'ready'
  ) {
    void access.loadGrants()
  }
})

const grants = computed(() => {
  const g = access.grants.value
  if (g.state === 'ready') return g.data
  // Unknown after an error: offer the delete and let the server decide.
  return g.state === 'error' ? [] : null
})
const decision = computed(() => deleteHubState(viewer, description, grants.value))

const open = ref(false)
const busy = ref(false)
const error = ref('')

function start() {
  error.value = ''
  open.value = true
}

async function confirm() {
  busy.value = true
  error.value = ''
  const result = await model.deleteHub()
  busy.value = false
  if (result.ok) {
    open.value = false
    await router.push('/')
    return
  }
  error.value = result.message
}
</script>

<template>
  <SettingsSection title="Delete this hub" data-danger-section>
    <div class="flex flex-col gap-3">
      <p class="m-0 text-ink2">
        A hub can be deleted once it holds no items and no folders. Deleting it revokes its agent
        keys and removes everyone’s access and its attributes. Revisions of items deleted earlier
        stay, readable by no one.
      </p>
      <p
        v-if="decision.kind === 'refused'"
        :id="reasonId"
        class="m-0 text-secondary text-ink3"
        data-delete-refused
      >
        {{ decision.reason }}
      </p>
      <div>
        <BaseButton
          danger
          :disabled="decision.kind !== 'allowed'"
          :aria-describedby="decision.kind === 'refused' ? reasonId : undefined"
          data-delete-hub
          @click="start"
          >{{ decision.kind === 'waiting' ? 'Checking who has access' : 'Delete hub' }}</BaseButton
        >
      </div>
    </div>
  </SettingsSection>

  <ConfirmDialog
    v-model:open="open"
    :title="`Delete ${description.hub.name}?`"
    message="The hub, its attributes, everyone’s access and its agent keys go. This cannot be undone. Type the hub’s name to confirm."
    confirm-label="Delete hub"
    :require-text="description.hub.name"
    :busy="busy"
    :error="error"
    @confirm="confirm"
  />
</template>
