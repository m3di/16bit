<script setup lang="ts">
import { computed, useId } from 'vue'
import { RouterLink } from 'vue-router'
import {
  fieldWidth,
  joinFields,
  measureText,
  moreText,
  splitFields,
  type DataBlockState,
  type FieldValue,
  type ListField,
  type ListGroup,
  type ListRow,
} from './blocks.ts'
import BaseButton from './BaseButton.vue'
import BlockStatus from './BlockStatus.vue'
import FieldText from './FieldText.vue'
import { paletteVar } from './palette.ts'

// The `list` block, from both mockups. `table` is Work.dc.html's backlog: fields in fixed-width
// columns (lead fields such as the ID before the title, the rest after), 38px rows. `summary` is
// Main.dc.html's current work: the first coloured field as a dot before the title and the fields
// as one quiet line ("In progress, Sara"), 36px rows. Groups have a caption header with up to 2
// measures ("Next up", "19 points").
const {
  groups,
  fields,
  variant = 'table',
  state = 'ready',
  stateTitle = '',
  stateMessage = null,
  emptyText = 'Nothing here yet',
  creatable,
  label = '',
} = defineProps<{
  groups: ListGroup[]
  /** Up to 4 (D77); more are not shown. */
  fields: ListField[]
  variant?: 'table' | 'summary'
  state?: DataBlockState
  stateTitle?: string
  stateMessage?: string | null
  /** Shown when the list, or a group, has no rows. */
  emptyText?: string
  /** "New item" under each group, which presets the group's value (D77). */
  creatable?: boolean
  /** Names an ungrouped list that has no section heading around it. */
  label?: string
}>()

const emit = defineEmits<{ open: [rowId: string]; create: [groupId: string] }>()

interface Cell {
  field: ListField
  value: FieldValue | undefined
  width: number
}

const split = computed(() => splitFields(fields))
const shown = computed(() => [...split.value.lead, ...split.value.rest])
const hasRows = computed(() => groups.some((g) => g.rows.length > 0 || (g.more ?? 0) > 0))
const baseId = useId()

function cells(row: ListRow, which: 'lead' | 'rest'): Cell[] {
  return split.value[which].map((field) => {
    const raw = row.values[field.key]
    // Lead fields are IDs: mono unless the renderer says otherwise.
    const value = raw && field.lead ? { ...raw, mono: raw.mono ?? true } : raw
    return { field, value, width: fieldWidth(field, value) }
  })
}
function dotColor(row: ListRow): string | undefined {
  const value = shown.value.map((f) => row.values[f.key]).find((v) => v?.color && !v.empty)
  return value?.color ? paletteVar(value.color) : undefined
}
function summaryText(row: ListRow): string {
  return joinFields(shown.value.map((f) => row.values[f.key]))
}
function onClick(row: ListRow) {
  if (!row.to) emit('open', row.id)
}
const rowClass = computed(() => [
  'flex w-full cursor-pointer items-center border-b border-line text-left text-ink hover:bg-surface',
  variant === 'summary' ? 'min-h-9 gap-2.5' : 'min-h-[38px] flex-wrap gap-x-3.5 gap-y-1.5 py-1',
])
</script>

<template>
  <BlockStatus
    v-if="state !== 'ready'"
    :state="state"
    :title="stateTitle"
    :message="stateMessage"
    :rows="4"
  />
  <BlockStatus v-else-if="!hasRows && !creatable" state="empty" :title="emptyText" message="" />
  <div v-else class="flex flex-col" data-block="list" :data-variant="variant">
    <div v-for="(group, gi) in groups" :key="group.id" class="flex flex-col">
      <h3
        v-if="group.label"
        :id="`${baseId}-${group.id}`"
        :class="[
          'm-0 flex justify-between gap-3 border-b border-line pb-1.5 text-caption font-normal text-ink3',
          gi === 0 ? 'pt-2.5' : 'pt-[18px]',
        ]"
      >
        <span>{{ group.label }}</span>
        <span v-if="measureText(group.measures)">{{ measureText(group.measures) }}</span>
      </h3>
      <ul
        v-if="group.rows.length > 0"
        class="m-0 flex list-none flex-col p-0"
        :aria-labelledby="group.label ? `${baseId}-${group.id}` : undefined"
        :aria-label="!group.label && label ? label : undefined"
      >
        <li
          v-for="row in group.rows"
          :key="row.id"
          :class="variant === 'summary' && 'last:[&>*]:border-b-0'"
        >
          <component
            :is="row.to ? RouterLink : 'button'"
            :to="row.to"
            :type="row.to ? undefined : 'button'"
            :class="rowClass"
            @click="onClick(row)"
          >
            <template v-if="variant === 'summary'">
              <span
                aria-hidden="true"
                :class="['size-1.5 shrink-0 rounded-full', !dotColor(row) && 'bg-line2']"
                :style="{ background: dotColor(row) }"
              />
              <span class="min-w-0 flex-1 truncate">{{ row.title }}</span>
              <span class="shrink-0 text-secondary text-ink3"
                ><span class="sr-only">, </span>{{ summaryText(row) }}</span
              >
            </template>
            <template v-else>
              <span
                v-for="cell in cells(row, 'lead')"
                :key="cell.field.key"
                :class="['flex shrink-0', cell.field.align === 'end' && 'justify-end']"
                :style="{ width: `${String(cell.width)}px` }"
              >
                <template v-if="cell.value">
                  <span class="sr-only">{{ `${cell.field.label} ` }}</span>
                  <FieldText :value="cell.value" />
                </template>
              </span>
              <span class="min-w-0 flex-[1_1_220px]">{{ row.title }}</span>
              <span
                v-for="cell in cells(row, 'rest')"
                :key="cell.field.key"
                :class="['flex shrink-0', cell.field.align === 'end' && 'justify-end']"
                :style="{ width: `${String(cell.width)}px` }"
              >
                <template v-if="cell.value">
                  <span class="sr-only">{{ `, ${cell.field.label} ` }}</span>
                  <FieldText
                    :value="cell.value"
                    :tone="cell.field.align === 'end' ? 'ink' : 'ink2'"
                  />
                </template>
              </span>
            </template>
          </component>
        </li>
      </ul>
      <p
        v-else-if="!(group.more ?? 0)"
        class="m-0 border-b border-line py-2.5 text-ink3"
        data-group-empty
      >
        {{ emptyText }}
      </p>
      <p v-if="moreText(group.more)" class="m-0 py-2 text-secondary text-ink3">
        {{ moreText(group.more) }}
      </p>
      <div v-if="creatable" class="py-1">
        <BaseButton variant="quiet" size="sm" class="-ml-3" @click="emit('create', group.id)">
          New item<span v-if="group.label" class="sr-only"> in {{ group.label }}</span>
        </BaseButton>
      </div>
    </div>
  </div>
</template>
