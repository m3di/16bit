<script setup lang="ts">
import type { Me } from '@16bit/core'
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import {
  BaseButton,
  SettingsLayout,
  paletteVar,
  type SettingsNavEntry,
  type SettingsState,
} from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import { truncatedNote } from '../hub/useHub.ts'
import AccessSection from './AccessSection.vue'
import { canEditGeneral, viewerOf } from './access.ts'
import AttributesSection from './AttributesSection.vue'
import DangerSection from './DangerSection.vue'
import FoldersSection from './FoldersSection.vue'
import GeneralSection from './GeneralSection.vue'
import KeysSection from './KeysSection.vue'
import {
  canManageSchema,
  READ_ONLY_REASON,
  SECTION_LABELS,
  SECTION_ROUTES,
  type HubSettingsSection,
} from './schema.ts'
import type { HubAccess } from './useHubAccess.ts'
import type { HubSettings } from './useHubSettings.ts'

const { workspaceId, hubId, section, model, access, me } = defineProps<{
  workspaceId: string
  hubId: string
  section: HubSettingsSection
  model: HubSettings
  /** Grants, members and agent keys, for the access and key sections. */
  access: HubAccess
  /** The session, for the reader's workspace role. */
  me: Load<Me | null>
}>()

const hub = computed(() => model.hub.value)
const description = computed(() => (hub.value.state === 'ready' ? hub.value.data : null))

const pageState = computed((): SettingsState => {
  if (me.state === 'loading' || hub.value.state === 'loading') return 'loading'
  if (me.state === 'error') return 'error'
  // Agents act through keys, not this page.
  if (me.data?.kind === 'agent') return 'no-permission'
  if (hub.value.state === 'error') {
    // A hub without a grant answers 404 like a missing one (D45).
    if (hub.value.error.isNotFound) return 'not-found'
    if (hub.value.error.isNoPermission) return 'no-permission'
    return 'error'
  }
  return 'ready'
})

const stateText = computed(() => {
  switch (pageState.value) {
    case 'not-found':
      return {
        title: 'This hub is not available',
        message: 'It may not exist, or it may not be shared with you.',
      }
    case 'no-permission':
      return { title: 'You do not have access to this', message: READ_ONLY_REASON }
    case 'error':
      return {
        title: 'The hub could not be loaded',
        message:
          me.state === 'error'
            ? me.error.message
            : hub.value.state === 'error'
              ? hub.value.error.message
              : '',
      }
    default:
      return { title: '', message: '' }
  }
})

const viewer = computed(() => viewerOf(me.state === 'ready' ? me.data : null, workspaceId))
const editsGeneral = computed(
  () => !!description.value && canEditGeneral(viewer.value, description.value.hubRole),
)

const manages = computed(() => {
  const d = description.value
  return !!d && canManageSchema(me.state === 'ready' ? me.data : null, workspaceId, d.hubRole)
})

const workspaceName = computed(() => {
  const m = me.state === 'ready' ? me.data : null
  return m?.kind === 'person'
    ? (m.memberships.find((x) => x.workspace.id === workspaceId)?.workspace.name ?? '')
    : ''
})

// A hidden hub answers 404 like a missing one (D45): its name never shows.
const hubName = computed(() => description.value?.hub.name ?? '')
const trail = computed(() =>
  [
    workspaceName.value,
    pageState.value === 'not-found' ? '' : hubName.value,
    'Hub settings',
  ].filter(Boolean),
)
const back = computed(() =>
  hubName.value && pageState.value !== 'not-found'
    ? {
        label: `Back to ${hubName.value}`,
        to: { name: 'hub', params: { workspaceId, hubId } },
      }
    : { label: 'Back to hubs', to: '/' },
)

const sections = computed((): SettingsNavEntry[] =>
  (Object.keys(SECTION_ROUTES) as HubSettingsSection[]).map((key) => ({
    key,
    label: SECTION_LABELS[key],
    to: { name: SECTION_ROUTES[key], params: { workspaceId, hubId } },
    danger: key === 'danger',
  })),
)

const title = computed(() => (pageState.value === 'ready' ? hubName.value : 'Hub settings'))
const schemaSection = computed(() => section === 'folders' || section === 'attributes')
const pageDescription = computed(() =>
  pageState.value === 'ready' && schemaSection.value && !manages.value
    ? `You can see this hub's folders and attributes. ${READ_ONLY_REASON}`
    : '',
)
const truncated = computed(() => (description.value ? truncatedNote(description.value) : ''))

// One status line for the page: what the last change did. Focused after a delete, since the
// row that had focus is gone.
const status = ref('')
const statusEl = useTemplateRef<HTMLElement>('statusEl')
async function onStatus(text: string, focus: boolean) {
  status.value = text
  if (!focus) return
  await nextTick()
  statusEl.value?.focus()
}
</script>

<template>
  <SettingsLayout
    :trail="trail"
    :back="back"
    nav-label="Hub settings"
    :sections="sections"
    :current="section"
    :title="title"
    :description="pageDescription"
    :state="pageState"
    :state-title="stateText.title"
    :state-message="stateText.message"
  >
    <template v-if="description" #leading>
      <span
        aria-hidden="true"
        class="size-3.5 shrink-0"
        :style="{ background: paletteVar(description.hub.color) }"
      />
    </template>
    <template v-if="pageState === 'error'" #state-action>
      <BaseButton size="sm" @click="model.load()">Try again</BaseButton>
    </template>

    <p
      ref="statusEl"
      tabindex="-1"
      role="status"
      class="m-0 text-secondary text-ink2 outline-none empty:hidden"
      data-settings-status
    >
      {{ status }}
    </p>
    <p v-if="truncated" class="m-0 text-secondary text-ink3" data-truncated>{{ truncated }}</p>

    <template v-if="description">
      <GeneralSection
        v-if="section === 'general'"
        :description="description"
        :manages="editsGeneral"
        :model="model"
      />
      <AccessSection
        v-else-if="section === 'access'"
        :viewer="viewer"
        :hub-role="description.hubRole"
        :hub-name="description.hub.name"
        :access="access"
        @status="onStatus"
        @self-change="model.load({ keep: true })"
      />
      <FoldersSection
        v-else-if="section === 'folders'"
        :description="description"
        :manages="manages"
        :model="model"
        @status="onStatus"
      />
      <AttributesSection
        v-else-if="section === 'attributes'"
        :description="description"
        :manages="manages"
        :model="model"
        @status="onStatus"
      />
      <KeysSection
        v-else-if="section === 'keys'"
        :viewer="viewer"
        :hub-role="description.hubRole"
        :hub-name="description.hub.name"
        :access="access"
        @status="onStatus"
      />
      <DangerSection
        v-else
        :viewer="viewer"
        :description="description"
        :model="model"
        :access="access"
      />
    </template>
  </SettingsLayout>
</template>
