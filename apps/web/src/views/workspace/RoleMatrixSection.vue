<script setup lang="ts">
import { computed } from 'vue'
import { DataTable, SettingsSection, type TableColumn } from '../../ui/index.ts'
import {
  CELL_TEXT,
  hubRoleCapText,
  roleMatrices,
  type MatrixCell,
  type MatrixRow,
  type RoleMatrix,
} from './role-matrix.ts'

// "What each role can do": read-only, generated from `can()` (issue 138). It needs no request,
// so it has no loading, empty or error state of its own; the page's states cover it.

const matrices = roleMatrices()
const capText = hubRoleCapText()

function columnsOf(m: RoleMatrix): TableColumn[] {
  return [
    { key: 'action', label: 'Action', rowHeader: true, wrap: true },
    ...m.columns.map((c) => ({ key: c.key, label: c.label, wrap: true })),
  ]
}

const rowsOf = (m: RoleMatrix) => m.rows.map((r) => ({ id: r.key, ...r }))

const cellOf = (row: MatrixRow, key: string): MatrixCell | undefined => row.cells[key]
const limitsOf = (row: MatrixRow, key: string) => {
  const cell = cellOf(row, key)
  return cell?.kind === 'limited' ? cell.limits : []
}

const tables = computed(() => [
  {
    key: 'workspace',
    caption: 'What each workspace role and an agent key can do in this workspace',
    columns: columnsOf(matrices.workspace),
    rows: rowsOf(matrices.workspace),
  },
  {
    key: 'hub',
    caption: 'What each hub role can do inside a hub',
    columns: columnsOf(matrices.hub),
    rows: rowsOf(matrices.hub),
  },
])
</script>

<template>
  <SettingsSection
    title="What each role can do"
    :description="`A workspace role sets what someone can do; a hub grant sets where. ${capText}`"
    data-role-matrix
  >
    <div class="flex min-w-0 flex-col gap-6">
      <DataTable
        v-for="t in tables"
        :key="t.key"
        mode="static"
        :caption="t.caption"
        :columns="t.columns"
        :rows="t.rows"
        :min-width="720"
        :row-attrs="(row) => ({ 'data-matrix-row': row.key })"
        :data-role-matrix-table="t.key"
      >
        <template #cell="{ row, column }">
          <template v-if="column.key === 'action'">{{ row.label }}</template>
          <span
            v-else-if="cellOf(row, column.key)?.kind === 'limited'"
            class="flex flex-col py-1"
            :data-cell="column.key"
          >
            <span>{{ CELL_TEXT.yes }}</span>
            <span
              v-for="limit in limitsOf(row, column.key)"
              :key="limit"
              class="text-secondary text-ink3"
              >{{ limit }}</span
            >
          </span>
          <span
            v-else-if="cellOf(row, column.key)"
            :class="cellOf(row, column.key)?.kind === 'no' && 'text-secondary text-ink3'"
            :data-cell="column.key"
            >{{ CELL_TEXT[cellOf(row, column.key)!.kind] }}</span
          >
        </template>
      </DataTable>
    </div>
  </SettingsSection>
</template>
