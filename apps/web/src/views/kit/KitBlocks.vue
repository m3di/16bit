<script setup lang="ts">
import { ref } from 'vue'
import {
  BarRows,
  BlockColumns,
  BlockSection,
  BlockStatus,
  BaseButton,
  BoardCard,
  BoardColumn,
  BoardView,
  FieldsInline,
  GroupedList,
  NoViewYet,
  NumberStat,
  PageHeader,
  type BarRow,
  type BoardColumnData,
  type DataBlockState,
  type ListField,
  type ListGroup,
  type LiveStatus,
} from '../../ui/index.ts'

// The two M4 mockups rebuilt from the block components with their sample data, then every
// block's states. The data is invented, as in the mockups.

const opened = ref('')
const created = ref('')

const live = ref<LiveStatus>('online')
const liveStates: LiveStatus[] = ['online', 'connecting', 'offline', 'stopped']

const sprintFields = [
  { key: 'start', label: 'Start', value: { text: 'Nov 9' } },
  { key: 'end', label: 'End', value: { text: 'Nov 20' } },
]

const currentFields: ListField[] = [
  { key: 'stage', label: 'Stage' },
  { key: 'owner', label: 'Owner' },
]
const stage = {
  progress: { text: 'In progress', color: 'amber' },
  review: { text: 'In review', color: 'blue' },
  qa: { text: 'In QA', color: 'violet' },
  done: { text: 'Done', color: 'green' },
} as const
const currentWork: ListGroup[] = [
  {
    id: 'all',
    label: '',
    rows: [
      ['w1', 'Delivery window picker', stage.progress, 'Sara'],
      ['w2', 'Live map on tracking page', stage.review, 'Tomas'],
      ['w3', 'Push notification on status change', stage.qa, 'Sara'],
      ['w4', 'Courier handoff API', stage.done, 'Kofi'],
      ['w5', 'Address autocomplete', stage.done, 'Priya'],
      ['w6', 'Fix duplicate scan events', stage.done, 'Lena'],
    ].map(([id, title, s, owner]) => ({
      id: id as string,
      title: title as string,
      values: { stage: s as (typeof stage)['done'], owner: { text: owner as string } },
    })),
  },
]

const team: BarRow[] = [
  {
    id: 'sara',
    label: 'Sara',
    actor: { id: 'sara', name: 'Sara', kind: 'person' },
    value: 10,
    max: 10,
    text: '10',
  },
  {
    id: 'tomas',
    label: 'Tomas',
    actor: { id: 'tomas', name: 'Tomas', kind: 'person' },
    value: 8,
    max: 10,
    text: '8',
  },
  {
    id: 'kofi',
    label: 'Kofi',
    actor: { id: 'kofi', name: 'Kofi', kind: 'person' },
    value: 0,
    max: 10,
    text: '0',
  },
  {
    id: 'qa',
    label: 'qa-agent',
    actor: { id: 'qa-agent', name: 'qa-agent', kind: 'agent' },
    value: 2,
    max: 10,
    text: '2',
  },
  {
    id: 'gone',
    label: '',
    actor: { id: 'u_7f3a91c2d4', kind: 'unknown' },
    value: 3,
    max: 10,
    text: '3',
  },
]
const epics: BarRow[] = [
  { id: 'e1', label: 'Courier tools', value: 11, max: 12, text: '11 of 12' },
  { id: 'e2', label: 'Tracking page', value: 9, max: 14, text: '9 of 14' },
  { id: 'e3', label: 'Notifications', value: 4, max: 9, text: '4 of 9' },
]

const board: BoardColumnData[] = [
  {
    id: 'todo',
    label: 'To do',
    color: 'grey',
    count: 1,
    cards: [
      {
        id: 'c1',
        title: 'Review the live map PR',
        fields: [
          { text: 'PT-219', mono: true },
          { text: '? points', empty: true },
        ],
      },
    ],
  },
  {
    id: 'progress',
    label: 'In progress',
    color: 'amber',
    count: 1,
    cards: [
      {
        id: 'c2',
        title: 'Delivery window picker',
        fields: [{ text: 'PT-214', mono: true }, { text: '5 points' }],
      },
    ],
  },
  {
    id: 'review',
    label: 'In review',
    color: 'blue',
    count: 0,
    cards: [],
    emptyText: 'Nothing of yours is in review.',
  },
  {
    id: 'qa',
    label: 'In QA',
    color: 'violet',
    count: 27,
    cards: [
      {
        id: 'c3',
        title: 'Push notification on status change',
        fields: [{ text: 'PT-217', mono: true }, { text: '5 points' }],
      },
    ],
  },
]

const backlogFields: ListField[] = [
  { key: 'id', label: 'ID', lead: true },
  { key: 'type', label: 'Type', width: 64 },
  { key: 'epic', label: 'Epic' },
  { key: 'points', label: 'Points', align: 'end' },
]
const type = {
  bug: { text: 'Bug', color: 'red' },
  story: { text: 'Story', color: 'blue' },
  chore: { text: 'Chore', color: 'slate' },
} as const
const noEpic = { text: 'No epic', empty: true }
const row = (id: string, title: string, t: keyof typeof type, epic: string, points: string) => ({
  id,
  title,
  values: {
    id: { text: id.toUpperCase() },
    type: type[t],
    epic: epic ? { text: epic } : noEpic,
    points: points === '?' ? { text: '?', empty: true } : { text: points },
  },
})
const backlog: ListGroup[] = [
  {
    id: 'next',
    label: 'Next up',
    measures: ['19 points'],
    rows: [
      row('pt-225', 'Retry failed webhooks', 'bug', 'Notifications', '3'),
      row('pt-226', 'Proof-of-delivery photo', 'story', 'Courier tools', '8'),
      row('pt-227', 'Dark mode for the tracking page', 'story', 'Tracking page', '5'),
      row('pt-228', 'Rate limit the public API', 'chore', '', '3'),
    ],
  },
  {
    id: 'later',
    label: 'Later',
    measures: ['13 points', '1 not estimated'],
    rows: [
      row('pt-230', 'Courier ratings', 'story', 'Courier tools', '?'),
      row('pt-231', 'Multi-parcel orders', 'story', 'Tracking page', '13'),
    ],
    more: 42,
  },
  { id: 'icebox', label: 'Icebox', measures: ['0 points'], rows: [] },
]

const blockStates: Exclude<DataBlockState, 'ready'>[] = [
  'loading',
  'empty',
  'error',
  'no-permission',
  'not-found',
  'invalid',
  'unresolved',
]
</script>

<template>
  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Blocks: project home</h3>
    <p class="m-0 text-caption text-ink3">
      Main.dc.html from PageHeader, BlockColumns, NumberStat, BlockSection, GroupedList (summary)
      and BarRows. The burndown and the sentence under the release bars are left out (D82).
    </p>
    <div class="flex flex-col gap-7 rounded-card border border-line p-6">
      <PageHeader title="Parcel Tracker v2" :live="live">
        <FieldsInline :fields="sprintFields" />
      </PageHeader>
      <BlockColumns ruled>
        <NumberStat label="Sprint day" value="6" of="10" />
        <NumberStat label="Points done" value="16" of="34" />
        <NumberStat label="In review or QA" value="2" />
        <NumberStat label="Open bugs" value="7" />
      </BlockColumns>
      <BlockColumns :weights="[3, 2]" :min="300">
        <BlockSection title="Sprint 24 burndown" caption="Points left by day">
          <BlockStatus state="loading" :rows="5" />
        </BlockSection>
        <BlockSection title="Current work" caption="Sprint 24, by stage">
          <GroupedList
            variant="summary"
            :groups="currentWork"
            :fields="currentFields"
            label="Current work"
            @open="opened = $event"
          />
        </BlockSection>
      </BlockColumns>
      <BlockColumns>
        <BlockSection title="Team" caption="Open points this sprint">
          <BarRows layout="inline" :rows="team" />
        </BlockSection>
        <BlockSection title="Release 2.0" caption="Items done per epic">
          <BarRows :rows="epics" />
        </BlockSection>
      </BlockColumns>
    </div>
    <div class="flex flex-wrap items-center gap-3 text-caption text-ink3">
      <span>Live dot:</span>
      <BaseButton
        v-for="s in liveStates"
        :key="s"
        size="sm"
        :variant="live === s ? 'outline' : 'quiet'"
        @click="live = s"
        >{{ s }}</BaseButton
      >
      <span v-if="opened" role="status">Opened {{ opened }}</span>
    </div>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Blocks: my work</h3>
    <p class="m-0 text-caption text-ink3">
      Work.dc.html from BoardView, BoardColumn, BoardCard and GroupedList (table). "In QA" has more
      cards than the 25 a column shows. The subtask bar and "1 of 9 test cases failed" are left out
      (D82). "New item" in a column or group presets its value (D77).
    </p>
    <div class="flex flex-col gap-8 rounded-card border border-line p-6">
      <PageHeader title="My work" />
      <BlockSection title="This sprint" caption="Items where Owner or Reviewer is you, by Stage">
        <BoardView :columns="board" creatable @open="opened = $event" @create="created = $event" />
      </BlockSection>
      <BlockSection title="Backlog">
        <template #actions><BaseButton>New item</BaseButton></template>
        <GroupedList
          :groups="backlog"
          :fields="backlogFields"
          creatable
          empty-text="Nothing in this group."
          @open="opened = $event"
          @create="created = $event"
        />
      </BlockSection>
    </div>
    <p v-if="created" role="status" class="m-0 text-caption text-ink3">New item in {{ created }}</p>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Block states</h3>
    <p class="m-0 text-caption text-ink3">
      D18's states, plus invalid (a removed or non-indexed attribute, D79) and unresolved (no
      current sprint, D77). Each replaces only its own block. Not found is for a block bound to one
      item.
    </p>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-5">
      <div v-for="s in blockStates" :key="s" class="flex flex-col gap-2">
        <span class="text-caption text-ink3">{{ s }}</span>
        <NumberStat label="Points done" :state="s" />
        <BlockSection title="Current work">
          <GroupedList :groups="[]" :fields="currentFields" :state="s" />
        </BlockSection>
      </div>
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-5">
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Board, unresolved</span>
        <BoardView
          :columns="[]"
          state="unresolved"
          state-title="No current sprint"
          state-message="This board shows the current sprint. None runs today."
        />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Bars, invalid</span>
        <BarRows
          :rows="[]"
          state="invalid"
          state-message="It sums Points, which is no longer indexed."
        />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Bars and list, empty</span>
        <BarRows :rows="[]" empty-text="No epics yet" />
        <GroupedList :groups="[]" :fields="currentFields" empty-text="Nothing in this sprint" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Fields, not found and stacked</span>
        <FieldsInline :fields="sprintFields" state="not-found" />
        <FieldsInline :fields="sprintFields" stacked />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Page header, loading</span>
        <PageHeader title="" loading live="connecting" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Card and column on their own</span>
        <BoardColumn label="Done" color="green" :count="0" :cards="[]" />
        <BoardCard title="Courier handoff API" :fields="[{ text: 'PT-210', mono: true }]" />
      </div>
    </div>
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">No view yet</h3>
    <p class="m-0 text-caption text-ink3">
      A views-only folder with no stored view (D76). Compose shows for hub admins only (D78).
    </p>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
      <div class="rounded-card border border-line"><NoViewYet compose-to="/kit#compose" /></div>
      <div class="rounded-card border border-line"><NoViewYet /></div>
    </div>
  </section>
</template>
