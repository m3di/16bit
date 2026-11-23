import { inject, provide, type ComponentPublicInstance, type InjectionKey } from 'vue'

// Where focus goes in the outline after a block is removed or moved (DESIGN.md, as
// OptionsEditor does): each row registers its buttons, and the composer focuses the one that
// makes sense once the outline has re-rendered.

export type OutlineControl = 'select' | 'up' | 'down'

export interface OutlineFocus {
  /** A template ref callback for one of a block's buttons. */
  register(id: string, control: OutlineControl): (el: unknown) => void
  focus(id: string, control: OutlineControl): void
}

const key: InjectionKey<OutlineFocus> = Symbol('outline focus')

const elementOf = (el: unknown): { focus(): void } | null => {
  const node: unknown = (el as ComponentPublicInstance | null)?.$el ?? el
  return node && typeof (node as { focus?: unknown }).focus === 'function'
    ? (node as { focus(): void })
    : null
}

export function provideOutlineFocus(): OutlineFocus {
  const buttons = new Map<string, { focus(): void }>()
  const focus: OutlineFocus = {
    register: (id, control) => (el) => {
      const found = elementOf(el)
      if (found) buttons.set(`${id}:${control}`, found)
      else buttons.delete(`${id}:${control}`)
    },
    focus: (id, control) => {
      buttons.get(`${id}:${control}`)?.focus()
    },
  }
  provide(key, focus)
  return focus
}

const none: OutlineFocus = { register: () => () => undefined, focus: () => undefined }

export const useOutlineFocus = (): OutlineFocus => inject(key, none)
