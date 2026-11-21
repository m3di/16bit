import type { Attribute, ItemValues } from '@16bit/core'
import { h, type FunctionalComponent, type VNodeChild } from 'vue'
import { ChipList, PaletteChip, UrlLink } from '../../ui/index.ts'
import ActorValue from './ActorValue.vue'
import { listValue } from './relations.ts'
import RelationValue from './RelationValue.vue'
import { formatValue, selectedOption } from './values.ts'

export interface ValueCellProps {
  /** Missing when the column has no attribute; the cell is then empty. */
  attribute: Attribute | undefined
  value: ItemValues[string] | undefined
}

/** Lists in a 36px row show this many entries and a "+N" count. */
const CELL_LIMIT = 2

/**
 * One value in a table cell. A functional component: a large folder mounts a few hundred cells
 * on every scroll step (D61, issue 218), so a cell has no instance and no reactive state of its
 * own, and only values that need one (chips, links, people, linked items) render a component.
 */
export const ValueCell: FunctionalComponent<ValueCellProps> = ({
  attribute,
  value,
}): VNodeChild => {
  // Empty cells stay blank, as for every other type, rather than repeating "Empty" down a column.
  if (
    !attribute ||
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  )
    return null
  switch (attribute.type) {
    case 'multi_select':
      return h(ChipList, {
        value: listValue(value),
        options: attribute.config.options,
        label: attribute.name,
        limit: CELL_LIMIT,
        inline: true,
      })
    case 'url':
      return h(UrlLink, { value: typeof value === 'string' ? value : null })
    case 'actor':
      return h(ActorValue, {
        inline: true,
        ids: listValue(value),
        label: attribute.name,
        limit: CELL_LIMIT,
      })
    case 'relation':
      return h(RelationValue, {
        inline: true,
        ids: listValue(value),
        label: attribute.name,
        limit: CELL_LIMIT,
      })
    case 'auto_id':
      return h('span', { class: 'font-mono text-secondary' }, formatValue(attribute, value))
    case 'rich_text': {
      // Rich text in a row is its plain text on one line.
      const text = formatValue(attribute, value)
      return h('span', { class: 'block max-w-80 truncate text-ink2', title: text }, text)
    }
    default: {
      const text = formatValue(attribute, value)
      const color = selectedOption(attribute, value)?.color
      return color ? h(PaletteChip, { color }, () => text) : text
    }
  }
}
ValueCell.props = ['attribute', 'value']
