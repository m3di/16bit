import type { BlockTypeName } from '@16bit/core'
import type { Component } from 'vue'
import BoardForm from './forms/BoardForm.vue'
import ChartForm from './forms/ChartForm.vue'
import ColumnsForm from './forms/ColumnsForm.vue'
import FieldsForm from './forms/FieldsForm.vue'
import HeadingForm from './forms/HeadingForm.vue'
import ListForm from './forms/ListForm.vue'
import NumberForm from './forms/NumberForm.vue'
import PageForm from './forms/PageForm.vue'
import SectionForm from './forms/SectionForm.vue'
import TableForm from './forms/TableForm.vue'
import TextForm from './forms/TextForm.vue'

// One form per block type in core's `BLOCK_TYPES` (D77, Q10), as the renderer has one
// component per type. The type makes a missing form a compile error; forms.test.ts checks it
// against core's list at run time too, so a block type added to core fails until it has one.

export const BLOCK_FORMS: { readonly [T in BlockTypeName]: Component } = {
  page: PageForm,
  section: SectionForm,
  columns: ColumnsForm,
  heading: HeadingForm,
  text: TextForm,
  table: TableForm,
  list: ListForm,
  board: BoardForm,
  number: NumberForm,
  chart: ChartForm,
  fields: FieldsForm,
}

export const blockForm = (type: BlockTypeName): Component | undefined =>
  (BLOCK_FORMS as Partial<Record<string, Component>>)[type]
