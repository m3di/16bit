<script setup lang="ts">
import { computed, onBeforeUnmount, useId, useTemplateRef, watch } from 'vue'
import type { SettingsState } from './settings.ts'
import StateBlock from './StateBlock.vue'

const open = defineModel<boolean>('open', { default: false })

const {
  title,
  description = '',
  state = 'ready',
  stateTitle = '',
  stateMessage = '',
  width = 'md',
  persistent,
} = defineProps<{
  /** The dialog's heading and accessible name. */
  title: string
  description?: string
  /**
   * What the body shows. `ready` shows the default slot; the others show a StateBlock in its
   * place: loading, empty, error, no-permission, and not-found for a dialog opened by ID.
   */
  state?: SettingsState
  stateTitle?: string
  stateMessage?: string
  /** md: 440px at most. lg: 640px at most. Never wider than the screen. */
  width?: 'md' | 'lg'
  /**
   * The dialog must stay open, such as while its action runs: Escape, the Close button, and the
   * backdrop do nothing, so the reader sees how the action ends.
   */
  persistent?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

defineSlots<{ default?(): unknown; footer?(): unknown; 'state-action'?(): unknown }>()

const id = useId()
const titleId = `${id}-title`
const descId = `${id}-desc`
const dialog = useTemplateRef<HTMLDialogElement>('dialog')
let returnFocus: HTMLElement | null = null

// A native modal <dialog>: the browser keeps focus inside, makes the page behind inert, and
// sends Escape as a `cancel` event. Focus goes to the first [autofocus] control, else the first
// focusable one, and back to whatever opened the dialog when it closes.
function sync(isOpen: boolean) {
  const el = dialog.value
  if (!el) return
  if (isOpen && !el.open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    el.showModal()
  } else if (!isOpen && el.open) {
    el.close()
  }
}

watch(
  [open, dialog],
  ([isOpen]) => {
    sync(isOpen)
  },
  { flush: 'post' },
)

function onClose() {
  // The browser can close a modal on Escape without a cancelable `cancel` event (repeated
  // Escape with no user activation). A dialog that must stay open opens again.
  if (open.value && persistent) {
    dialog.value?.showModal()
    return
  }
  open.value = false
  emit('close')
  // Return focus only if nothing else took it: the opener may be gone (a removed row), and
  // the parent may already have moved focus somewhere better.
  const active = document.activeElement
  const unclaimed = !active || active === document.body || dialog.value?.contains(active)
  if (unclaimed && returnFocus?.isConnected) returnFocus.focus()
  returnFocus = null
}

function dismiss() {
  if (!persistent) open.value = false
}

function onCancel(event: Event) {
  // Escape closes through the model, so the parent's state stays the source of truth.
  event.preventDefault()
  dismiss()
}

// A click on the backdrop (the dialog element itself, outside its box) closes it, but only when
// the press started there too: selecting text in a field and letting go outside does not.
let pressedBackdrop = false
function onPointerdown(event: PointerEvent) {
  pressedBackdrop = event.target === dialog.value
}
function onClick(event: MouseEvent) {
  if (pressedBackdrop && event.target === dialog.value) dismiss()
  pressedBackdrop = false
}

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close()
})

const maxWidth = computed(() => (width === 'lg' ? 'max-w-[640px]' : 'max-w-[440px]'))
</script>

<template>
  <dialog
    ref="dialog"
    :aria-labelledby="titleId"
    :aria-describedby="description ? descId : undefined"
    :class="[
      'm-auto box-border w-[calc(100%-32px)] rounded-card border border-line2 bg-bg p-0 text-ink',
      'backdrop:bg-bg/80',
      maxWidth,
    ]"
    @close="onClose"
    @cancel="onCancel"
    @pointerdown="onPointerdown"
    @click="onClick"
  >
    <div v-if="open" class="flex flex-col gap-4 p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h2 :id="titleId" class="m-0 font-display text-card-title font-medium">{{ title }}</h2>
          <p v-if="description" :id="descId" class="m-0 text-ink2">{{ description }}</p>
        </div>
        <button
          type="button"
          aria-label="Close"
          :disabled="persistent"
          class="-mt-1 -mr-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-ink3 hover:bg-selected hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          @click="dismiss"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 10 10" class="size-2.5">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" fill="none" />
          </svg>
        </button>
      </div>
      <div v-if="state === 'ready'" class="flex min-w-0 flex-col gap-4"><slot /></div>
      <StateBlock v-else :state="state" :title="stateTitle" :message="stateMessage">
        <template v-if="$slots['state-action']" #action><slot name="state-action" /></template>
      </StateBlock>
      <div
        v-if="$slots.footer"
        class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4"
      >
        <slot name="footer" />
      </div>
    </div>
  </dialog>
</template>
