<script setup lang="ts">
import { MAX_FILTER_CONDITIONS, type FilterCondition, type FilterOperator } from '@16bit/core'
import { computed, ref } from 'vue'
import { BaseButton, BaseSelect } from '../../../ui/index.ts'
import ComposerTextarea from '../ComposerTextarea.vue'
import {
  build,
  flatten,
  operatorsFor,
  startValue,
  valueEditor,
  valueShape,
  type ConditionList,
  type MatchMode,
} from '../conditions.ts'
import { itemBound } from '../defaults.ts'
import { useField } from '../form-context.ts'
import { attributesFor } from '../options.ts'
import { OP_LABELS } from '../words.ts'
import ConditionValue from './ConditionValue.vue'

// A filter (D79) as a one-level list of conditions on indexed attributes, all or any of them,
// with "Edit as JSON" for nested trees and operands the list has no editor for (Q10).
const {
  path,
  folderId,
  label = 'Filter',
  required,
  blocks,
} = defineProps<{
  path: string
  folderId: string
  label?: string
  /** An item rule always has a filter; elsewhere none means every item. */
  required?: boolean
  /** `$block` may be used here (everywhere but an item rule, D77). */
  blocks?: boolean
}>()

const { form, value, error } = useField(() => path)

const attributes = computed(() => attributesFor(form.schema(), folderId, { indexed: true }))
const list = computed(() => flatten(value.value))
const json = ref(list.value === null)
const jsonText = ref('')
const jsonError = ref('')

function write(next: ConditionList) {
  value.value = build(next, required)
}

function setMode(mode: string) {
  if (list.value) write({ ...list.value, mode: mode as MatchMode })
}

function setRow(i: number, row: FilterCondition) {
  const l = list.value
  if (!l) return
  write({ ...l, rows: l.rows.map((r, j) => (j === i ? row : r)) })
}

function setAttribute(i: number, attributeId: string) {
  const row = list.value?.rows[i]
  if (!row) return
  const a = attributes.value.find((x) => x.id === attributeId)
  const ops = operatorsFor(a)
  const op = ops.includes(row.op) ? row.op : (ops[0] ?? 'eq')
  setRow(i, withValue({ attribute: attributeId, op }, startValue(op)))
}

function setOp(i: number, op: string) {
  const row = list.value?.rows[i]
  if (!row) return
  const next = op as FilterOperator
  // A value of the same shape (one value, or a list) carries over; otherwise it starts again.
  const keep = valueShape(next) === valueShape(row.op) && valueShape(next) !== 'none'
  setRow(i, withValue({ attribute: row.attribute, op: next }, keep ? row.value : startValue(next)))
}

const withValue = (c: FilterCondition, v: unknown): FilterCondition =>
  v === undefined
    ? { attribute: c.attribute, op: c.op }
    : { attribute: c.attribute, op: c.op, value: v }

function add() {
  const l = list.value
  const a = attributes.value[0]
  if (!l || !a) return
  const op = operatorsFor(a)[0] ?? 'eq'
  write({ ...l, rows: [...l.rows, withValue({ attribute: a.id, op }, startValue(op))] })
}

function remove(i: number) {
  const l = list.value
  if (l) write({ ...l, rows: l.rows.filter((_, j) => j !== i) })
}

function openJson() {
  jsonText.value = value.value === undefined ? '' : JSON.stringify(value.value, null, 2)
  jsonError.value = ''
  json.value = true
}

function applyJson() {
  const text = jsonText.value.trim()
  if (text === '') {
    jsonError.value = ''
    value.value = required ? { and: [] } : undefined
    return
  }
  try {
    value.value = JSON.parse(text) as unknown
    jsonError.value = ''
  } catch (e) {
    jsonError.value = `This is not valid JSON, so it was not applied. ${e instanceof Error ? e.message : ''}`
  }
}

if (json.value) openJson()

const extras = computed(() => ({
  blocks: blocks ? itemBound(form.root()) : null,
  people: form.people(),
}))
const MODES = [
  { value: 'and', label: 'All of these' },
  { value: 'or', label: 'Any of these' },
]
const attributeOptions = computed(() =>
  attributes.value.map((a) => ({ value: a.id, label: a.name })),
)
const opOptions = (attributeId: string) =>
  operatorsFor(attributes.value.find((a) => a.id === attributeId)).map((op) => ({
    value: op,
    label: OP_LABELS[op],
  }))
const shownAttributes = (attributeId: string) =>
  attributeOptions.value.some((o) => o.value === attributeId)
    ? attributeOptions.value
    : [{ value: attributeId, label: `${attributeId} (not available)` }, ...attributeOptions.value]
</script>

<template>
  <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-composer-conditions>
    <legend class="mb-1 p-0 text-secondary text-ink3">{{ label }}</legend>

    <template v-if="json">
      <ComposerTextarea
        v-model="jsonText"
        :label="`${label} as JSON`"
        mono
        :rows="6"
        :error="jsonError"
        hint='A filter as POST /query takes it: { "and": [...] }, { "or": [...] } or one condition. Applied when you leave the field.'
        data-conditions-json
        @change="applyJson"
      />
      <div>
        <BaseButton size="sm" :disabled="list === null || !!jsonError" @click="json = false"
          >Edit as list</BaseButton
        >
      </div>
    </template>

    <template v-else-if="list">
      <p v-if="list.rows.length === 0" class="m-0 text-secondary text-ink3">
        {{
          required
            ? 'No conditions: the first item in the folder.'
            : 'No conditions: every item in the folder.'
        }}
      </p>
      <div v-else-if="list.rows.length > 1" class="max-w-60">
        <BaseSelect
          :model-value="list.mode"
          :label="`Items must match`"
          :options="MODES"
          @update:model-value="setMode"
        />
      </div>
      <div
        v-for="(row, i) in list.rows"
        :key="i"
        class="flex flex-wrap items-start gap-2 border-t border-line pt-2"
        data-condition
      >
        <div class="min-w-36 flex-[1_1_140px]">
          <BaseSelect
            :model-value="row.attribute"
            :label="`Condition ${String(i + 1)} attribute`"
            :options="shownAttributes(row.attribute)"
            @update:model-value="setAttribute(i, $event)"
          />
        </div>
        <div class="min-w-32 flex-[1_1_120px]">
          <BaseSelect
            :model-value="row.op"
            :label="`Condition ${String(i + 1)} test`"
            :options="opOptions(row.attribute)"
            @update:model-value="setOp(i, $event)"
          />
        </div>
        <div class="min-w-40 flex-[2_1_160px]">
          <ConditionValue
            :model-value="row.value"
            :editor="
              valueEditor(
                attributes.find((a) => a.id === row.attribute),
                row.op,
                extras,
              )
            "
            :label="`Condition ${String(i + 1)} value`"
            @update:model-value="setRow(i, withValue(row, $event))"
          />
        </div>
        <BaseButton size="sm" variant="quiet" class="mt-5" @click="remove(i)"
          >Remove<span class="sr-only"> condition {{ i + 1 }}</span></BaseButton
        >
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton
          size="sm"
          :disabled="attributes.length === 0 || list.rows.length >= MAX_FILTER_CONDITIONS"
          @click="add"
          >Add condition</BaseButton
        >
        <BaseButton size="sm" variant="quiet" data-conditions-edit-json @click="openJson"
          >Edit as JSON</BaseButton
        >
      </div>
      <span v-if="attributes.length === 0" class="text-secondary text-ink3"
        >This folder shows no indexed attribute to filter on.</span
      >
    </template>

    <span v-if="error" class="text-secondary text-danger" data-field-error>{{ error }}</span>
  </fieldset>
</template>
