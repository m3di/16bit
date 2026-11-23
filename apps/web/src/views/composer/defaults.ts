import {
  GROUP_TYPES,
  MAX_BOARD_COLUMNS,
  MAX_BOARD_CARDS,
  type Attribute,
  type BlockTypeName,
} from '@16bit/core'
import { BLOCK_LABELS, walk, type ComposerSchema, type DraftBlock } from './tree.ts'

// What a block starts as when it is added. A data block binds the folder being composed when
// it holds items, else the first one that does, and picks the first attribute that fits. Where
// nothing fits (a board in a folder with no select), the field stays empty and the form says
// what is missing, as core does.

const indexed = (attrs: Attribute[], types?: readonly string[]) =>
  attrs.filter((a) => a.indexed && (!types || types.includes(a.type)))

export function bindingFolder(schema: ComposerSchema, folderId: string): string {
  return schema.itemFolders.some((f) => f.id === folderId)
    ? folderId
    : (schema.itemFolders[0]?.id ?? '')
}

export function setBinding(folderId: string, limit = 50) {
  return { folderId, sort: [], limit }
}

export const itemRule = (folderId: string) => ({
  by: 'rule',
  folderId,
  where: { and: [] },
  sort: [],
})

export function boardColumn(attrs: Attribute[]) {
  const select = indexed(attrs, ['select'])[0]
  const options = select?.type === 'select' ? select.config.options : []
  return {
    attribute: select?.id ?? '',
    options: options.slice(0, MAX_BOARD_COLUMNS).map((o) => ({ option: o.id })),
  }
}

export const firstGroup = (attrs: Attribute[]) => {
  const a = indexed(attrs, GROUP_TYPES)[0]
  return { attribute: a?.id ?? '', ...(a?.type === 'date' ? { bucket: 'week' } : {}) }
}

/** A kind's config for `number` and `chart`, keeping the label. */
export function kindConfig(
  type: 'number' | 'chart',
  kind: string,
  folderId: string,
  schema: ComposerSchema,
  root: DraftBlock,
  label?: unknown,
): Record<string, unknown> {
  const attrs = schema.attributesOf(folderId)
  const dates = attrs.filter((a) => a.type === 'date')
  const keep = typeof label === 'string' ? { label } : {}
  if (type === 'number' && kind === 'days') {
    return {
      kind,
      ...keep,
      binding: itemRule(folderId),
      start: dates[0]?.id ?? '',
      end: dates[1]?.id ?? dates[0]?.id ?? '',
      days: 'weekdays',
    }
  }
  if (type === 'number')
    return { kind: 'aggregate', ...keep, binding: setBinding(folderId), value: { fn: 'count' } }
  if (kind === 'burndown') {
    const range = itemBound(root)[0]
    return {
      kind,
      ...keep,
      binding: setBinding(folderId),
      range: { block: range?.id ?? '', start: '', end: '' },
      doneOn: indexed(attrs, ['date'])[0]?.id ?? '',
      days: 'weekdays',
    }
  }
  return {
    kind: 'bars',
    ...keep,
    binding: setBinding(folderId),
    groupBy: firstGroup(attrs),
    measures: [{ fn: 'count' }],
  }
}

/** A new block of `type`, bound as said above. */
export function defaultConfig(
  type: BlockTypeName,
  schema: ComposerSchema,
  folderId: string,
  root: DraftBlock,
): Record<string, unknown> {
  const bound = bindingFolder(schema, folderId)
  const attrs = schema.attributesOf(bound)
  switch (type) {
    case 'page':
    case 'section':
    case 'columns':
      return {}
    case 'heading':
      return { text: 'Heading', level: 2 }
    case 'text':
      return { text: 'Text' }
    case 'table':
      return { binding: setBinding(bound) }
    case 'list':
      return { binding: setBinding(bound), fields: [], create: false }
    case 'board':
      return {
        binding: setBinding(bound, MAX_BOARD_CARDS),
        column: boardColumn(attrs),
        fields: [],
        create: false,
      }
    case 'number':
      return kindConfig('number', 'aggregate', bound, schema, root)
    case 'chart':
      return kindConfig('chart', 'bars', bound, schema, root)
    case 'fields':
      return {
        binding: itemRule(bound),
        fields: attrs.slice(0, 1).map((a) => a.id),
        layout: 'stacked',
      }
  }
}

/** Blocks bound to one item, which `$block` and a burndown's range may name (D77). */
export function itemBound(root: DraftBlock): { id: string; label: string }[] {
  return walk(root).flatMap(({ block }) => {
    const c = block.config
    const item = block.type === 'fields' || (block.type === 'number' && c['kind'] === 'days')
    return item ? [{ id: block.id, label: `${BLOCK_LABELS[block.type]} "${block.id}"` }] : []
  })
}

/** A short line naming a block in the outline: its title, text or label, else its folder. */
export function summaryOf(block: DraftBlock, schema: ComposerSchema | null): string {
  const c = block.config
  for (const key of ['title', 'text', 'label']) {
    const v = c[key]
    if (typeof v === 'string' && v.trim()) return v.trim().split('\n')[0]?.slice(0, 60) ?? ''
  }
  const binding = c['binding']
  if (binding && typeof binding === 'object' && 'folderId' in binding) {
    const id = String(binding.folderId)
    const d = schema?.description
    const name = d?.hub.id === id ? d.hub.name : d?.folders.find((f) => f.id === id)?.name
    return name ?? ''
  }
  return ''
}
