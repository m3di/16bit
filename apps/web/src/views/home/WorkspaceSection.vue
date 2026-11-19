<script setup lang="ts">
import { computed } from 'vue'
import { BaseButton, FormNotice, HubCard, StateBlock } from '../../ui/index.ts'
import { selfGrantKey, type SelfGrant, type WorkspaceEntry } from './useDashboard.ts'

const {
  entry,
  canSelfGrant,
  canCreateHub,
  selfGrants = new Map<string, SelfGrant>(),
} = defineProps<{
  entry: WorkspaceEntry
  /** The reader is an owner or admin here, so may grant themselves access (D45). */
  canSelfGrant?: boolean
  /** `hub.create`: owners and admins. */
  canCreateHub?: boolean
  selfGrants?: ReadonlyMap<string, SelfGrant>
}>()
defineEmits<{
  retry: []
  grantSelf: [hubId: string]
  dismissSelfGrant: [hubId: string]
  newHub: []
}>()

const ask = (hubId: string) => selfGrants.get(selfGrantKey(entry.workspace.id, hubId))

const headingId = computed(() => `workspace-${entry.workspace.id}`)

// A workspace that is gone, or whose hubs the reader may not list, takes no new hubs either.
const offersNewHub = computed(
  () =>
    canCreateHub &&
    !(
      entry.hubs.state === 'error' &&
      (entry.hubs.error.isNoPermission || entry.hubs.error.isNotFound)
    ),
)
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-3.5" data-workspace>
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
      <h2 :id="headingId" class="m-0 text-body font-medium">{{ entry.workspace.name }}</h2>
      <div class="flex flex-wrap items-center gap-4">
        <BaseButton
          v-if="offersNewHub"
          size="sm"
          variant="quiet"
          data-new-hub-button
          @click="$emit('newHub')"
          >New hub<span class="sr-only"> in {{ entry.workspace.name }}</span></BaseButton
        >
        <!-- Every person in the workspace may see its members; what they can change follows the role. -->
        <RouterLink
          :to="{ name: 'workspace-members', params: { workspaceId: entry.workspace.id } }"
          class="border-b border-line2 text-secondary text-ink3 no-underline hover:border-line3 hover:text-ink"
          data-members-link
          >Members and roles<span class="sr-only"> of {{ entry.workspace.name }}</span></RouterLink
        >
      </div>
    </div>

    <StateBlock v-if="entry.hubs.state === 'loading'" state="loading" title="Loading hubs" />
    <StateBlock
      v-else-if="entry.hubs.state === 'error' && entry.hubs.error.isNoPermission"
      state="no-permission"
      title="You do not have access to this workspace's hubs"
    />
    <StateBlock
      v-else-if="entry.hubs.state === 'error' && entry.hubs.error.isNotFound"
      state="not-found"
      title="This workspace is not available"
      message="It may have been deleted, or you may no longer belong to it."
    />
    <StateBlock
      v-else-if="entry.hubs.state === 'error'"
      state="error"
      title="The hubs could not be loaded"
      :message="entry.hubs.error.message"
    >
      <template #action>
        <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
      </template>
    </StateBlock>
    <StateBlock
      v-else-if="entry.hubs.data.length === 0"
      state="empty"
      title="No hubs yet"
      :message="
        canCreateHub
          ? 'Create a hub to start adding items. You become its hub admin.'
          : 'Hubs in this workspace will show here.'
      "
    >
      <template v-if="canCreateHub" #action>
        <BaseButton size="sm" @click="$emit('newHub')"
          >New hub<span class="sr-only"> in {{ entry.workspace.name }}</span></BaseButton
        >
      </template>
    </StateBlock>
    <ul v-else class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-0">
      <li v-for="hub in entry.hubs.data" :key="hub.id" class="flex min-w-0 flex-col">
        <HubCard
          v-if="hub.access === 'granted'"
          :name="hub.name"
          :color="hub.color"
          :count="hub.itemCount"
          :to="{ name: 'hub', params: { workspaceId: hub.workspaceId, hubId: hub.id } }"
          class="flex-1"
        />
        <!-- Owners and admins without a grant: name only, and a way to grant themselves access. -->
        <template v-else>
          <HubCard :name="hub.name" :color="hub.color" no-access class="flex-1" />
          <div v-if="canSelfGrant" class="flex flex-col gap-1 pt-1.5" data-self-grant>
            <!-- Access was given, but the list could not be read again to open the hub. -->
            <FormNotice v-if="ask(hub.id)?.state === 'stale'" data-self-grant-stale>
              The hubs could not be loaded again. You now have access to {{ hub.name }}; load them
              to open it.
              <template #action>
                <BaseButton size="sm" variant="quiet" @click="$emit('retry')"
                  >Load hubs again</BaseButton
                >
              </template>
            </FormNotice>
            <span v-else>
              <BaseButton
                size="sm"
                variant="quiet"
                :disabled="ask(hub.id)?.state === 'busy'"
                @click="$emit('grantSelf', hub.id)"
                >{{ ask(hub.id)?.state === 'busy' ? 'Giving access' : 'Give myself access'
                }}<span class="sr-only"> to {{ hub.name }}</span></BaseButton
              >
            </span>
            <FormNotice v-if="ask(hub.id)?.state === 'error'" data-self-grant-error>
              {{ (ask(hub.id) as { message: string }).message }}
              <template #action>
                <BaseButton size="sm" variant="quiet" @click="$emit('dismissSelfGrant', hub.id)"
                  >Dismiss</BaseButton
                >
              </template>
            </FormNotice>
          </div>
        </template>
      </li>
    </ul>
  </section>
</template>
