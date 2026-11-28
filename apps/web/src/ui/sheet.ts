import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** From this width up the item panel sits beside the content; below it, it is a sheet (D85). */
export const BESIDE_QUERY = '(min-width: 64rem)'

/** The part of an element `inertOutside` touches; `HTMLElement` has it. */
export type InertNode = {
  inert: boolean
  parentElement: InertNode | null
  children: ArrayLike<object>
}

const canBeInert = (n: object): n is InertNode => 'inert' in n

/**
 * Makes everything on the page outside `el` inert, as a modal dialog does: every sibling of `el`
 * and of each of its ancestors up to `stop` (the body). Siblings that were inert already, and
 * those that cannot be (SVG), are left alone. Returns the function that undoes it.
 */
export function inertOutside(el: InertNode, stop: InertNode | null = null): () => void {
  const changed: InertNode[] = []
  for (let at: InertNode | null = el; at && at !== stop; at = at.parentElement) {
    const parent: InertNode | null = at.parentElement
    if (!parent) break
    for (const sibling of Array.from<object>(parent.children)) {
      if (sibling === at || !canBeInert(sibling) || sibling.inert) continue
      sibling.inert = true
      changed.push(sibling)
    }
  }
  return () => {
    for (const s of changed) s.inert = false
  }
}

/**
 * Whether the viewport is narrow enough for the item panel to be a full-screen sheet. Without a
 * browser (server rendering, tests) it is beside the content, as on a desktop.
 */
export function useSheet(): Ref<boolean> {
  const sheet = ref(false)
  let media: MediaQueryList | undefined
  const update = () => {
    sheet.value = !!media && !media.matches
  }
  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    media = window.matchMedia(BESIDE_QUERY)
    update()
    media.addEventListener('change', update)
  })
  onBeforeUnmount(() => media?.removeEventListener('change', update))
  return sheet
}
