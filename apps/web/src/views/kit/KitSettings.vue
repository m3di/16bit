<script setup lang="ts">
import type { AttributeTypeName, PaletteColor, SelectOption } from '@16bit/core'
import { ref } from 'vue'
import {
  AttributeTypePicker,
  BaseButton,
  BaseDialog,
  BaseInput,
  BaseSelect,
  ConfirmDialog,
  DataTable,
  OptionsEditor,
  PalettePicker,
  RowActionsMenu,
  SettingsLayout,
  SettingsSection,
  StateBlock,
  TabList,
  ToggleSwitch,
  paletteVar,
  type RowAction,
  type SettingsNavEntry,
  type TableColumn,
} from '../../ui/index.ts'

const { theme } = defineProps<{ theme: 'light' | 'dark' }>()

const nav: SettingsNavEntry[] = [
  { key: 'overview', label: 'Overview', to: '/kit#overview' },
  { key: 'access', label: 'Access', to: '/kit#access' },
  { key: 'folders', label: 'Folders', to: '/kit#folders' },
  { key: 'attributes', label: 'Attributes', to: '/kit#attributes' },
  { key: 'agents', label: 'Agents and keys', to: '/kit#agents' },
  { key: 'danger', label: 'Danger zone', to: '/kit#danger', danger: true },
]
const layoutStates = ['loading', 'error', 'no-permission', 'not-found'] as const

const tab = ref<'general' | 'options' | 'usage'>('general')
const tabs = [
  { key: 'general' as const, label: 'General' },
  { key: 'options' as const, label: 'Options' },
  { key: 'usage' as const, label: 'Usage' },
]

const dialogOpen = ref(false)
const stateDialog = ref<null | 'loading' | 'error' | 'not-found'>(null)
const folderName = ref('')
const confirmPlain = ref(false)
const confirmNamed = ref(false)
const confirmBusy = ref(false)
const confirmError = ref('')
const lastAction = ref('')

const memberActions: RowAction[] = [
  { key: 'role', label: 'Change role' },
  { key: 'resend', label: 'Resend invite' },
  { key: 'owner', label: 'Make owner', disabled: true, reason: 'Only the owner can do this' },
  { key: 'remove', label: 'Remove from workspace', danger: true },
]

// Static table: rows are never selected; the role and actions cells hold controls and wrap.
const staticColumns: TableColumn[] = [
  { key: 'name', label: 'Name', rowHeader: true, wrap: true },
  { key: 'role', label: 'Role', wrap: true },
  { key: 'hubs', label: 'Hubs' },
  { key: 'actions', label: 'Actions', labelHidden: true, align: 'end', shrink: true },
]
const staticRows = ref([
  { id: 'm1', name: 'Priya', role: 'admin', hubs: 'All hubs', locked: '' },
  { id: 'm2', name: 'Kofi', role: 'member', hubs: 'Engineering, Roadmap', locked: '' },
  {
    id: 'm3',
    name: 'Sara',
    role: 'owner',
    hubs: 'All hubs, including the ones made after today, which is a long list to read',
    locked: 'The only owner',
  },
])
const memberRoles = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
]

const color = ref<PaletteColor | null>('indigo')
const noColor = ref<PaletteColor | null>(null)

const crossHub = ref(false)
const indexed = ref(true)

const attrType = ref<AttributeTypeName | null>(null)

const options = ref<SelectOption[]>([
  { id: 'o1', label: 'Backlog', color: 'slate' },
  { id: 'o2', label: 'In progress', color: 'blue' },
  { id: 'o3', label: 'In review', color: 'amber' },
  { id: 'o4', label: 'Done', color: 'green' },
  { id: 'o5', label: "Won't do" },
])
const usage = { o1: 372, o2: 18, o3: 6, o4: 0, o5: 1280 }
const confirmState = ref<null | 'loading' | 'not-found'>(null)

function onDeleteHub() {
  confirmBusy.value = true
  setTimeout(() => {
    confirmBusy.value = false
    confirmError.value = 'Engineering still holds 412 items. Move or delete them first.'
  }, 1500)
}
</script>

<template>
  <div class="flex flex-col gap-9">
    <h3 class="m-0 border-b border-line pb-2 font-display text-card-title font-medium">
      Settings components (M2)
    </h3>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">SettingsLayout</h3>
      <div class="overflow-hidden rounded-card border border-line [&>div]:h-auto [&>div]:min-h-0">
        <SettingsLayout
          :trail="['Parcel Tracker', 'Engineering', 'Hub settings']"
          :back="{ label: 'Back to Engineering', to: '/kit' }"
          nav-label="Hub settings"
          :sections="nav"
          current="overview"
          title="Engineering"
        >
          <template #leading
            ><span
              aria-hidden="true"
              class="size-3.5"
              :style="{ background: paletteVar('indigo') }"
          /></template>
          <template #actions
            ><span class="text-secondary text-ink3">All changes saved</span></template
          >
          <SettingsSection title="General">
            <BaseInput model-value="Engineering" label="Name" />
          </SettingsSection>
          <SettingsSection
            title="Folders"
            description="A folder can narrow who opens it. It can never let in someone who is not in the hub."
          >
            <template #actions><BaseButton>New folder</BaseButton></template>
            <p class="m-0 text-ink2">The folders table goes here.</p>
          </SettingsSection>
        </SettingsLayout>
      </div>
      <p class="m-0 text-caption text-ink3">
        Page states. Not found and no permission drop the section navigation and keep the way back.
      </p>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        <div
          v-for="s in layoutStates"
          :key="s"
          class="overflow-hidden rounded-card border border-line [&>div]:h-auto [&>div]:min-h-0"
        >
          <SettingsLayout
            :trail="['Parcel Tracker']"
            :back="{ label: 'Back to hubs', to: '/kit' }"
            nav-label="Workspace settings"
            :sections="nav.slice(0, 2)"
            current="overview"
            title="Hub settings"
            :state="s"
            :state-title="s === 'not-found' ? 'This hub is not available' : ''"
            :state-message="
              s === 'not-found' ? 'It may not exist, or it may not be shared with you.' : ''
            "
          />
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">SettingsSection</h3>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        <SettingsSection title="Access" state="loading" />
        <SettingsSection
          title="Folders"
          state="empty"
          state-title="No folders yet"
          state-message="Folders group the items in a hub."
        >
          <template #state-action><BaseButton size="sm">New folder</BaseButton></template>
        </SettingsSection>
        <SettingsSection title="Attributes" state="error" state-message="Try again in a moment." />
        <SettingsSection
          title="Agents and keys"
          state="no-permission"
          state-message="Only workspace owners and admins manage keys."
        />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Table, static rows</h3>
      <SettingsSection title="People">
        <DataTable
          mode="static"
          :caption="`People and their roles, ${theme}`"
          :columns="staticColumns"
          :rows="staticRows"
          :min-width="420"
        >
          <template #cell="{ row, column }">
            <template v-if="column.key === 'name'">{{ row.name }}</template>
            <template v-else-if="column.key === 'role'">
              <span v-if="row.locked" class="inline-flex flex-wrap items-baseline gap-x-2">
                <span>Owner</span>
                <span class="text-secondary text-ink3">{{ row.locked }}</span>
              </span>
              <div v-else class="w-36">
                <BaseSelect
                  v-model="row.role"
                  :label="`Role for ${row.name}`"
                  label-hidden
                  size="sm"
                  :options="memberRoles"
                />
              </div>
            </template>
            <template v-else-if="column.key === 'hubs'">{{ row.hubs }}</template>
            <RowActionsMenu
              v-else
              :label="`Actions for ${row.name}, ${theme}`"
              :items="row.locked ? [] : memberActions"
              @select="lastAction = `Chose ${$event} for ${row.name}`"
            />
          </template>
        </DataTable>
      </SettingsSection>
      <p class="m-0 text-caption text-ink3">
        For settings lists whose rows hold their own controls. A click never selects a row, and
        there is no hover fill. Cells sit flush with the heading, 12px apart, 38px high. Name, Role,
        and the menu never cut short; Hubs is cut with an ellipsis. Sara's row is read-only, with
        the reason beside the role and no menu. Loading, empty, and error belong to the section
        around the table. Below 420px the table scrolls in its own box.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Tabs</h3>
      <TabList v-model="tab" :label="`Attribute settings, ${theme}`" :tabs="tabs">
        <template #default="{ tab: current }">
          <p v-if="current === 'general'" class="m-0 text-ink2">Name, type, and filter options.</p>
          <StateBlock v-else-if="current === 'options'" state="loading" />
          <StateBlock
            v-else
            state="empty"
            title="Not used yet"
            message="No folder uses this attribute."
          />
        </template>
      </TabList>
      <p class="m-0 text-caption text-ink3">
        One tab stop. Arrow keys move and select, Home and End jump. Panels show their own states.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Dialog</h3>
      <div class="flex flex-wrap gap-2">
        <BaseButton @click="dialogOpen = true">Open dialog</BaseButton>
        <BaseButton @click="stateDialog = 'loading'">Dialog loading</BaseButton>
        <BaseButton @click="stateDialog = 'error'">Dialog error</BaseButton>
        <BaseButton @click="stateDialog = 'not-found'">Dialog not found</BaseButton>
      </div>
      <BaseDialog
        v-model:open="dialogOpen"
        title="New folder"
        description="Folders group items. Everyone in the hub can open a new folder."
      >
        <BaseInput v-model="folderName" label="Name" autofocus />
        <PalettePicker v-model="color" label="Colour" />
        <template #footer>
          <BaseButton @click="dialogOpen = false">Cancel</BaseButton>
          <BaseButton variant="primary" :disabled="!folderName" @click="dialogOpen = false"
            >Create folder</BaseButton
          >
        </template>
      </BaseDialog>
      <BaseDialog
        :open="stateDialog !== null"
        title="Folder"
        :state="stateDialog ?? 'loading'"
        :state-title="stateDialog === 'not-found' ? 'This folder is not available' : ''"
        :state-message="
          stateDialog === 'not-found'
            ? 'It may not exist, or it may not be shared with you.'
            : stateDialog === 'error'
              ? 'The server did not answer.'
              : ''
        "
        @update:open="stateDialog = null"
      />
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">ConfirmDialog</h3>
      <div class="flex flex-wrap gap-2">
        <BaseButton danger @click="confirmPlain = true">Remove Kofi</BaseButton>
        <BaseButton
          danger
          @click="
            () => {
              confirmError = ''
              confirmNamed = true
            }
          "
          >Delete Engineering</BaseButton
        >
      </div>
      <ConfirmDialog
        v-model:open="confirmPlain"
        title="Remove Kofi from the workspace?"
        message="Kofi loses access to every hub here. Their items and comments stay."
        confirm-label="Remove Kofi"
        @confirm="
          () => {
            lastAction = 'Removed Kofi'
            confirmPlain = false
          }
        "
      />
      <ConfirmDialog
        v-model:open="confirmNamed"
        title="Delete Engineering?"
        message="The hub, its folders, attributes, and access are deleted. This cannot be undone."
        confirm-label="Delete hub"
        require-text="Engineering"
        :busy="confirmBusy"
        :error="confirmError"
        @confirm="onDeleteHub"
      />
      <div class="flex flex-wrap gap-2">
        <BaseButton @click="confirmState = 'loading'">Confirm loading</BaseButton>
        <BaseButton @click="confirmState = 'not-found'">Confirm not found</BaseButton>
      </div>
      <ConfirmDialog
        :open="confirmState !== null"
        title="Delete hub?"
        confirm-label="Delete hub"
        require-text="Engineering"
        :state="confirmState ?? 'loading'"
        :state-title="confirmState === 'not-found' ? 'This hub is not available' : ''"
        :state-message="
          confirmState === 'not-found' ? 'It may not exist, or it may not be shared with you.' : ''
        "
        @update:open="confirmState = null"
      />
      <p class="m-0 text-caption text-ink3" role="status">
        {{ lastAction || 'The named confirm fails on purpose, to show its error.' }}
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">RowActionsMenu</h3>
      <div class="flex flex-wrap items-center gap-6">
        <span class="flex items-center gap-2"
          >Tomas
          <RowActionsMenu
            :label="`Actions for Tomas, ${theme}`"
            :items="memberActions"
            @select="lastAction = `Chose ${$event}`"
        /></span>
        <span class="flex items-center gap-2"
          >Loading <RowActionsMenu label="Actions, loading" :items="memberActions" state="loading"
        /></span>
        <span class="flex items-center gap-2"
          >Error <RowActionsMenu label="Actions, error" :items="[]" state="error"
        /></span>
        <span class="flex items-center gap-2 text-ink3"
          >No permission: no button
          <RowActionsMenu label="Actions" :items="memberActions" state="no-permission"
        /></span>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">PalettePicker</h3>
      <div class="flex flex-col gap-4">
        <PalettePicker v-model="color" :label="`Hub colour, ${theme}`" />
        <PalettePicker v-model="noColor" label="Option colour, small" size="sm" allow-none />
        <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
          <PalettePicker label="Loading" state="loading" />
          <PalettePicker label="Error" state="error" />
          <PalettePicker
            model-value="teal"
            label="No permission"
            state="no-permission"
            reason="Only hub admins change this."
          />
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">ToggleSwitch</h3>
      <div class="flex max-w-md flex-col gap-3">
        <ToggleSwitch
          v-model="crossHub"
          :label="`Relations to other hubs, ${theme}`"
          :description="
            crossHub
              ? 'On: items here can link to items in another hub.'
              : 'Off: items here cannot link to items in another hub.'
          "
        />
        <span class="flex items-center gap-3"
          >Filter and sort by Stage
          <ToggleSwitch v-model="indexed" label="Filter and sort by Stage" label-hidden
        /></span>
        <ToggleSwitch :model-value="true" label="Disabled" disabled />
        <ToggleSwitch
          :model-value="true"
          label="No permission"
          state="no-permission"
          reason="Only hub admins change this."
        />
        <ToggleSwitch label="Loading" state="loading" />
        <ToggleSwitch label="Error" state="error" />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">AttributeTypePicker</h3>
      <AttributeTypePicker
        v-model="attrType"
        :error="attrType ? '' : 'Choose a type.'"
        :label="`Type, ${theme}`"
      />
      <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        <AttributeTypePicker model-value="relation" locked label="Locked (D51)" />
        <AttributeTypePicker label="Loading" state="loading" />
        <AttributeTypePicker label="Error" state="error" />
        <AttributeTypePicker model-value="select" label="No permission" state="no-permission" />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">OptionsEditor</h3>
      <div class="max-w-lg">
        <OptionsEditor v-model="options" :label="`Stage options, ${theme}`" :usage="usage" />
      </div>
      <p class="m-0 text-caption text-ink3">
        Removing an option that items use asks first (D51). Done is unused, so it goes at once.
      </p>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        <OptionsEditor :model-value="[]" label="Empty" />
        <OptionsEditor label="Loading" state="loading" />
        <OptionsEditor label="Error" state="error" />
        <OptionsEditor :model-value="options" label="No permission" state="no-permission" />
      </div>
    </section>
  </div>
</template>
