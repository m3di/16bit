<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef } from 'vue'
import { rovingIndex } from './roving.ts'
import { anchorMoved, menuOpenFocus, type AnchorRect } from './settings.ts'

export interface RowAction {
  key: string
  label: string
  /** Destructive: shown in --danger. */
  danger?: boolean
  /** Shown but not usable. Give the reason, read under the label. */
  disabled?: boolean
  reason?: string
}

const {
  label,
  items,
  state = 'ready',
} = defineProps<{
  /** Names the button for screen readers, with the row: "Actions for Tomas". */
  label: string
  items: readonly RowAction[]
  /**
   * loading: the button waits (the actions depend on data still loading). error: the menu opens
   * to say the actions could not load. no-permission: the reader can do nothing on this row, so
   * the button is not rendered at all; screens must not offer actions that are always refused.
   * An empty `items` list renders nothing too, except in the error state.
   */
  state?: 'ready' | 'loading' | 'error' | 'no-permission'
}>()

const emit = defineEmits<{ select: [key: string] }>()

// In the error state the menu holds one unusable entry that says so, so focus has somewhere to
// go and the reader hears why there is nothing to choose.
const ERROR_KEY = '__error'
const shown = computed<readonly RowAction[]>(() =>
  state === 'error' ? [{ key: ERROR_KEY, label: 'Actions could not load', disabled: true }] : items,
)

const id = useId()
const menuId = `${id}-menu`
const open = ref(false)
const position = ref({ top: 0, left: 0 })
const button = useTemplateRef<HTMLButtonElement>('button')
const menu = useTemplateRef<HTMLElement>('menu')
const entries = useTemplateRef<HTMLElement[]>('entries')
// Where the button was when the menu was last placed.
let placedAt: AnchorRect | null = null

// The menu sits in the top layer (popover), so table rows and scroll boxes never clip it. It is
// placed under the button's right edge, and above it when there is no room below.
function place() {
  const b = button.value?.getBoundingClientRect()
  const m = menu.value?.getBoundingClientRect()
  if (!b) return
  placedAt = { top: b.top, left: b.left, bottom: b.bottom, right: b.right }
  const height = m?.height ?? 0
  const width = m?.width ?? 0
  const below = b.bottom + 4
  const above = b.top - 4 - height
  const top = below + height > window.innerHeight && above > 0 ? above : below
  position.value = { top, left: Math.max(8, b.right - width) }
}

async function show(focus: 'first' | 'last' = 'first') {
  open.value = true
  await nextTick()
  menu.value?.showPopover()
  place()
  focusEntry(focus === 'first' ? 0 : (entries.value?.length ?? 1) - 1)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  document.addEventListener('pointerdown', onOutside, true)
}

function hide(returnFocus = false) {
  if (!open.value) return
  if (menu.value?.matches(':popover-open')) menu.value.hidePopover()
  open.value = false
  placedAt = null
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  document.removeEventListener('pointerdown', onOutside, true)
  if (returnFocus) button.value?.focus()
}

// The menu is placed once; when the page moves the button, it closes rather than drift. A scroll
// or resize that leaves the button where it was cannot have moved it: the late scroll event from
// focusing a button below the fold arrives a frame after Enter opened the menu (issue 157). Then the
// menu stays, placed again in case the viewport changed size.
function onViewportChange() {
  const b = button.value?.getBoundingClientRect()
  if (!b || !placedAt || anchorMoved(placedAt, b)) hide()
  else place()
}

function onOutside(event: PointerEvent) {
  const target = event.target as Node | null
  if (target && (menu.value?.contains(target) || button.value?.contains(target))) return
  hide()
}

function focusEntry(index: number) {
  entries.value?.[index]?.focus()
}

// Enter and Space reach `toggle` through the button's own click. Up and Down open it too.
function onButtonKeydown(event: KeyboardEvent) {
  const focus = menuOpenFocus(event.key)
  if (!focus) return
  event.preventDefault()
  void show(focus)
}

function onMenuKeydown(event: KeyboardEvent) {
  const list = entries.value ?? []
  const current = list.findIndex((el) => el === document.activeElement)
  if (event.key === 'Escape') {
    // Only the menu closes, not a dialog it sits in.
    event.preventDefault()
    event.stopPropagation()
    hide(true)
    return
  }
  if (event.key === 'Tab') {
    // Tab leaves the menu; it closes and focus moves on from the button as usual.
    hide()
    return
  }
  const next = rovingIndex(Math.max(current, 0), event.key, list.length, 'vertical')
  if (next === null) return
  event.preventDefault()
  focusEntry(next)
}

function choose(item: RowAction) {
  if (item.disabled) return
  hide(true)
  emit('select', item.key)
}

function toggle() {
  if (open.value) hide(true)
  else void show('first')
}

onBeforeUnmount(() => {
  hide()
})
</script>

<template>
  <span
    v-if="state !== 'no-permission' && (items.length > 0 || state === 'error')"
    class="inline-flex"
  >
    <button
      ref="button"
      type="button"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open ? menuId : undefined"
      :disabled="state === 'loading'"
      :aria-busy="state === 'loading' ? 'true' : undefined"
      class="inline-flex size-7 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-ink3 hover:bg-selected hover:text-ink disabled:cursor-wait aria-expanded:bg-selected aria-expanded:text-ink"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <!-- Three pixel squares: the 16-bit "more" mark. -->
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 14 2"
        shape-rendering="crispEdges"
        class="h-0.5 w-3.5"
      >
        <path d="M0 0h2v2h-2zM6 0h2v2h-2zM12 0h2v2h-2z" fill="currentColor" />
      </svg>
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      popover="manual"
      role="menu"
      :aria-label="label"
      class="fixed m-0 box-border flex min-w-40 flex-col gap-px rounded-card border border-line2 bg-bg p-1 text-ink"
      :style="{ inset: 'auto', top: `${position.top}px`, left: `${position.left}px` }"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="item in shown"
        ref="entries"
        :key="item.key"
        type="button"
        role="menuitem"
        tabindex="-1"
        :aria-disabled="item.disabled ? 'true' : undefined"
        :aria-describedby="item.disabled && item.reason ? `${id}-${item.key}-reason` : undefined"
        :class="[
          'flex min-h-8 cursor-pointer flex-col items-start justify-center rounded-control border-0 bg-transparent px-2 text-left',
          'hover:bg-selected focus-visible:bg-selected',
          item.key === ERROR_KEY
            ? 'cursor-default text-danger'
            : item.disabled
              ? 'cursor-not-allowed text-ink3'
              : item.danger
                ? 'text-danger'
                : 'text-ink',
        ]"
        @click="choose(item)"
      >
        {{ item.label }}
        <span
          v-if="item.disabled && item.reason"
          :id="`${id}-${item.key}-reason`"
          class="text-caption text-ink3"
          >{{ item.reason }}</span
        >
      </button>
    </div>
  </span>
</template>
