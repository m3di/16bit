import type { Attribute, AttributeUsage } from '@16bit/core'
import { ref } from 'vue'
import { asRequestError } from '../../api/client.ts'

/**
 * How many items use each option of the attribute being edited (`GET /attributes/:id/usage`), for the options editor.
 * `none`: not a select, or a new attribute. `stale`: the counts came back for another version of
 * the attribute, so they would belong to another option set and are not shown.
 */
export type OptionUsage =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; counts: Readonly<Record<string, number>> }
  | { state: 'stale' }
  | { state: 'error'; message: string; retry: boolean }

const hasOptions = (a: Attribute | null): a is Attribute =>
  !!a && (a.type === 'select' || a.type === 'multi_select')

/**
 * Reads the counts each time the editor opens on an existing select or multi-select. Only the
 * latest read lands, so a dialog reopened on another attribute never shows the first one's counts.
 */
export function useOptionUsage(read: (attribute: Attribute) => Promise<AttributeUsage>) {
  const usage = ref<OptionUsage>({ state: 'none' })
  let generation = 0

  async function load(attribute: Attribute | null) {
    const gen = ++generation
    if (!hasOptions(attribute)) {
      usage.value = { state: 'none' }
      return
    }
    usage.value = { state: 'loading' }
    try {
      const answer = await read(attribute)
      if (gen !== generation) return
      usage.value =
        answer.version === attribute.version
          ? {
              state: 'ready',
              counts: Object.fromEntries(answer.options.map((o) => [o.optionId, o.items])),
            }
          : { state: 'stale' }
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      usage.value = error.isNoPermission
        ? {
            state: 'error',
            message: 'Only hub admins see how many items use each option.',
            retry: false,
          }
        : error.isNotFound
          ? { state: 'error', message: 'This attribute is no longer available.', retry: false }
          : {
              state: 'error',
              message: `How many items use each option could not be loaded. ${error.message} Saving still asks before it clears any item's value.`,
              retry: true,
            }
    }
  }

  function clear() {
    generation++
    usage.value = { state: 'none' }
  }

  return { usage, load, clear }
}

/** The line under the options editor for this state, or `''`. */
export function usageNote(usage: OptionUsage, type: Attribute['type'] | null): string {
  switch (usage.state) {
    case 'loading':
      return 'Counting the items that use each option.'
    case 'stale':
      return 'Someone changed these options since the page loaded, so their counts are not shown. Saving checks for the change.'
    case 'ready':
      // One item can hold several options, so the counts overlap.
      return type === 'multi_select'
        ? 'An item can hold several of these options, so the counts can add up to more than the items that use any of them.'
        : ''
    default:
      return ''
  }
}
