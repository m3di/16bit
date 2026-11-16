<script setup lang="ts">
import { computed, h, type VNode } from 'vue'
import {
  isRichTextEmpty,
  normalizeRichText,
  type RichBlock,
  type RichInline,
  type RichListItem,
} from './rich-text.ts'
import { RICH_CLASSES as C } from './rich-text-classes.ts'
import type { ValueStateName } from './value-types.ts'
import ValueState from './ValueState.vue'

const {
  doc,
  state = 'ready',
  label = '',
} = defineProps<{
  /** A rich text value. Anything outside the closed node set is dropped before rendering. */
  doc: unknown
  state?: Exclude<ValueStateName, 'empty'> | 'ready'
  /** Accessible name for the document region, usually the attribute name. */
  label?: string
}>()

const clean = computed(() => normalizeRichText(doc))
const empty = computed(() => isRichTextEmpty(clean.value))

// Rendered as VNodes, never as HTML strings, so stored text cannot inject markup.
function inline(nodes: RichInline[] | undefined): (VNode | string)[] {
  return (nodes ?? []).map((n) => {
    if (n.type === 'hardBreak') return h('br')
    let node: VNode | string = n.text
    for (const mark of n.marks ?? []) {
      if (mark.type === 'bold') node = h('strong', { class: C.bold }, [node])
      else if (mark.type === 'italic') node = h('em', { class: C.italic }, [node])
      else if (mark.type === 'code') node = h('code', { class: C.code }, [node])
      else
        node = h(
          'a',
          { href: mark.attrs.href, target: '_blank', rel: 'noopener noreferrer', class: C.link },
          [node],
        )
    }
    return node
  })
}

function item(li: RichListItem): VNode {
  return h('li', { class: C.listItem }, li.content.map(block))
}

function block(b: RichBlock): VNode {
  switch (b.type) {
    case 'paragraph':
      return h('p', { class: C.paragraph }, inline(b.content))
    case 'heading':
      return h(`h${String(b.attrs.level)}`, { class: C.heading }, inline(b.content))
    case 'codeBlock':
      return h('pre', { class: C.codeBlock }, [h('code', inline(b.content))])
    case 'bulletList':
      return h('ul', { class: C.bulletList }, b.content.map(item))
    case 'orderedList':
      return h('ol', { class: C.orderedList, start: b.attrs?.start }, b.content.map(item))
  }
}

const Body = () => clean.value.content.map(block)
</script>

<template>
  <ValueState v-if="state !== 'ready'" :state="state" />
  <ValueState v-else-if="empty" state="empty" />
  <div v-else :class="C.root" :role="label ? 'region' : undefined" :aria-label="label || undefined">
    <Body />
  </div>
</template>
