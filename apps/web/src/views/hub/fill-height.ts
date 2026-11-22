import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * The height that takes an element from where it starts on the page down to the bottom of the
 * viewport, less the padding and borders the page ends with below it, and never less than `min`.
 * `top` is the element's top in page coordinates (not the scrolled position), so the height does
 * not change while the page scrolls.
 */
export function fillHeight({
  viewport,
  top,
  below,
  min,
}: {
  viewport: number
  top: number
  below: number
  min: number
}): number {
  return Math.max(min, Math.floor(viewport - top - below))
}

/** The part of an element the layout code reads; `HTMLElement` has it. */
export type LaidOut = {
  parentElement: LaidOut | null
  previousElementSibling: LaidOut | null
}

/**
 * What can move an element's top or change the space under it: each ancestor (it grows when
 * content above pushes the element down) and everything before the element or an ancestor (a
 * notice, a heading that wraps, the sidebar stacked above at phone width). A removed element is
 * reported with size zero, so a notice going away is seen too.
 */
export function layoutSources<T extends LaidOut>(element: T): T[] {
  const out: T[] = []
  for (let at: T | null = element; at; at = at.parentElement as T | null) {
    if (at !== element) out.push(at)
    for (let s = at.previousElementSibling as T | null; s; s = s.previousElementSibling as T | null)
      out.push(s)
  }
  return out
}

/**
 * Sizes an element to fill the viewport below it (issue 232): the hub page's items area, whose
 * virtual table needs a definite height to scroll inside (D61). `null` until measured, so the
 * caller keeps a CSS fallback for the first render. Measured again when the window or anything
 * above the element changes size, never while the table scrolls.
 */
export function useFillHeight(target: Ref<HTMLElement | null>, min: number): Ref<number | null> {
  const height = ref<number | null>(null)
  let observer: ResizeObserver | undefined
  let frame = 0

  function measure() {
    frame = 0
    const el = target.value
    if (!el) return
    let below = 0
    for (let at = el.parentElement; at && at !== document.documentElement; at = at.parentElement) {
      const style = getComputedStyle(at)
      below += parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth)
    }
    height.value = fillHeight({
      viewport: window.innerHeight,
      top: el.getBoundingClientRect().top + window.scrollY,
      below,
      min,
    })
    // A notice or folder list that appeared since the last time is watched from now on.
    for (const source of layoutSources(el)) observer?.observe(source)
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure)
  }

  onMounted(() => {
    observer = new ResizeObserver(schedule)
    window.addEventListener('resize', schedule)
    measure()
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
    if (frame) cancelAnimationFrame(frame)
  })
  return height
}
