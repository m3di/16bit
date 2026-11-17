<script setup lang="ts">
import { ref } from 'vue'
import {
  ActorChip,
  AuthLayout,
  CheckboxField,
  ChipList,
  RelationChip,
  RichTextView,
  SignInForm,
  UrlLink,
  ValueState,
  type ChipOption,
  type RichDoc,
} from '../../ui/index.ts'
import RichTextEditor from '../../ui/RichTextEditor.vue'

const states = ['loading', 'error', 'no-permission'] as const

const done = ref(true)
const notified = ref(false)

const tagOptions: ChipOption[] = [
  { id: 'web', label: 'Web', color: 'blue' },
  { id: 'api', label: 'API', color: 'teal' },
  { id: 'ios', label: 'iOS', color: 'violet' },
  { id: 'android', label: 'Android', color: 'green' },
  { id: 'infra', label: 'Infra' },
  { id: 'long', label: 'Push notifications and email digests', color: 'amber' },
]
const tags = ref(['web', 'api', 'infra'])
function removeTag(id: string) {
  tags.value = tags.value.filter((t) => t !== id)
}

const description: RichDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'When a parcel changes status, the recipient gets a ' },
        { type: 'text', text: 'push notification', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' within a minute. See ' },
        {
          type: 'text',
          text: 'the spec',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }],
        },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'notify()', marks: [{ type: 'code' }] },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Statuses' }] },
    {
      type: 'bulletList',
      content: ['Picked up', 'Out for delivery', 'Delivered, or delayed'].map((text) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    },
    {
      type: 'orderedList',
      content: ['Respect quiet hours', 'Retry once on token refresh'].map((text) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    },
    {
      type: 'codeBlock',
      content: [{ type: 'text', text: 'POST /v1/notify\n{ "status": "delayed" }' }],
    },
  ],
}
const draft = ref<unknown>(description)
const notes = ref<unknown>(null)
const failed = ref<unknown>(null)
</script>

<template>
  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">ValueState</h3>
    <div class="flex flex-wrap items-center gap-5">
      <ValueState state="loading" />
      <ValueState state="empty" />
      <ValueState state="error" />
      <ValueState state="no-permission" />
    </div>
    <p class="m-0 text-caption text-ink3">
      The four states (D18) for a single value. Every value component below uses them.
    </p>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Checkbox</h3>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      <CheckboxField v-model="done" label="Done" />
      <CheckboxField v-model="notified" label="Customer notified" hint="Sent by the agent." />
      <CheckboxField :model-value="false" label="Blocked" error="Could not save. Try again." />
      <CheckboxField :model-value="true" label="Approved" state="no-permission" />
      <CheckboxField :model-value="false" label="Archived" state="loading" />
      <CheckboxField :model-value="false" label="Reviewed" state="error" />
      <CheckboxField :model-value="false" label="Disabled" disabled />
    </div>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">ChipList (multi-select)</h3>
    <dl class="m-0 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
      <dt class="text-ink3">Removable</dt>
      <dd class="m-0">
        <ChipList
          :value="tags"
          :options="tagOptions"
          label="Platforms"
          removable
          @remove="removeTag"
        />
      </dd>
      <dt class="text-ink3">Limited</dt>
      <dd class="m-0">
        <ChipList
          :value="['web', 'api', 'ios', 'android']"
          :options="tagOptions"
          label="Platforms"
          :limit="2"
        />
      </dd>
      <dt class="text-ink3">Inline</dt>
      <dd class="m-0 min-w-0">
        <!-- A table cell: one line in a narrow box, long labels cut, the count kept. -->
        <div class="w-56 max-w-full border-b border-line py-2">
          <ChipList
            :value="['long', 'web', 'api', 'ios']"
            :options="tagOptions"
            label="Platforms"
            :limit="2"
            inline
          />
        </div>
      </dd>
      <dt class="text-ink3">Deleted option</dt>
      <dd class="m-0">
        <ChipList :value="['ios', 'old-option']" :options="tagOptions" label="Platforms" />
      </dd>
      <dt class="text-ink3">Empty</dt>
      <dd class="m-0"><ChipList :value="[]" :options="tagOptions" label="Platforms" /></dd>
      <template v-for="s in states" :key="s">
        <dt class="text-ink3">{{ s }}</dt>
        <dd class="m-0">
          <ChipList :value="[]" :options="tagOptions" label="Platforms" :state="s" />
        </dd>
      </template>
    </dl>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">UrlLink</h3>
    <dl class="m-0 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
      <dt class="text-ink3">Web</dt>
      <dd class="m-0 min-w-0"><UrlLink value="https://www.github.com/m3di/16bit/pull/478/" /></dd>
      <dt class="text-ink3">Mail</dt>
      <dd class="m-0 min-w-0"><UrlLink value="mailto:sara@example.com" /></dd>
      <dt class="text-ink3">Not a link</dt>
      <dd class="m-0 min-w-0"><UrlLink value="javascript:alert(1)" /></dd>
      <dt class="text-ink3">Empty</dt>
      <dd class="m-0"><UrlLink :value="null" /></dd>
      <template v-for="s in states" :key="s">
        <dt class="text-ink3">{{ s }}</dt>
        <dd class="m-0"><UrlLink :value="null" :state="s" /></dd>
      </template>
    </dl>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">ActorChip</h3>
    <dl class="m-0 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
      <dt class="text-ink3">Person</dt>
      <dd class="m-0"><ActorChip :actor="{ id: 'sara', name: 'Sara', kind: 'person' }" /></dd>
      <dt class="text-ink3">Agent</dt>
      <dd class="m-0">
        <ActorChip :actor="{ id: 'qa-agent', name: 'qa-agent', kind: 'agent' }" />
      </dd>
      <dt class="text-ink3">Unknown</dt>
      <dd class="m-0">
        <ActorChip :actor="{ id: '7f3c9a21e4b04d6c', kind: 'unknown' }" />
      </dd>
      <dt class="text-ink3">Large</dt>
      <dd class="m-0">
        <ActorChip :actor="{ id: 'kofi', name: 'Kofi', kind: 'person' }" size="lg" />
      </dd>
      <dt class="text-ink3">Empty</dt>
      <dd class="m-0"><ActorChip :actor="null" /></dd>
      <template v-for="s in states" :key="s">
        <dt class="text-ink3">{{ s }}</dt>
        <dd class="m-0"><ActorChip :actor="null" :state="s" /></dd>
      </template>
    </dl>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">RelationChip</h3>
    <dl class="m-0 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
      <dt class="text-ink3">Linked</dt>
      <dd class="m-0 min-w-0">
        <RelationChip
          :target="{ access: 'ok', id: 'i1', title: 'Notifications', displayId: 'PT-12' }"
          to="/kit"
        />
      </dd>
      <dt class="text-ink3">Not linked</dt>
      <dd class="m-0 min-w-0">
        <RelationChip :target="{ access: 'ok', id: 'i2', title: 'Sprint 24' }" />
      </dd>
      <dt class="text-ink3">No access</dt>
      <dd class="m-0"><RelationChip :target="{ access: 'none', id: 'i3' }" /></dd>
      <dt class="text-ink3">Empty</dt>
      <dd class="m-0"><RelationChip :target="null" /></dd>
      <dt class="text-ink3">loading</dt>
      <dd class="m-0"><RelationChip :target="null" state="loading" /></dd>
      <dt class="text-ink3">error</dt>
      <dd class="m-0"><RelationChip :target="null" state="error" /></dd>
    </dl>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">RichTextView</h3>
    <div class="max-w-[620px]"><RichTextView :doc="description" label="Description" /></div>
    <dl class="m-0 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
      <dt class="text-ink3">Empty</dt>
      <dd class="m-0"><RichTextView :doc="null" /></dd>
      <template v-for="s in states" :key="s">
        <dt class="text-ink3">{{ s }}</dt>
        <dd class="m-0"><RichTextView :doc="null" :state="s" /></dd>
      </template>
    </dl>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">RichTextEditor</h3>
    <div class="flex max-w-[620px] flex-col gap-5">
      <RichTextEditor v-model="draft" label="Description" />
      <RichTextEditor
        v-model="notes"
        label="Notes"
        placeholder="Add notes for the reviewer"
        hint="Empty state."
      />
      <RichTextEditor
        v-model="failed"
        label="With error"
        error="Could not save. Your text is kept here."
      />
      <RichTextEditor :model-value="description" label="Read only" state="no-permission" />
      <RichTextEditor :model-value="null" label="Loading" state="loading" />
      <RichTextEditor :model-value="null" label="Failed to load" state="error" />
    </div>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">SignInForm</h3>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6">
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Empty</span>
        <SignInForm />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Submitting</span>
        <SignInForm state="submitting" initial-email="sara@example.com" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Error</span>
        <SignInForm state="error" initial-email="sara@example.com" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">No permission</span>
        <SignInForm state="no-permission" initial-email="sara@example.com" />
      </div>
    </div>
    <span class="text-caption text-ink3">AuthLayout, the page around the form</span>
    <div class="h-[460px] overflow-hidden rounded-card border border-line">
      <AuthLayout title="Sign in" subtitle="Use the email your invite was sent to.">
        <SignInForm />
        <template #footer
          >No account? Ask an owner or admin of your workspace for an invite.</template
        >
      </AuthLayout>
    </div>
  </section>
</template>
