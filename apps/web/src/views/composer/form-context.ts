import type { Principal } from '@16bit/core'
import { computed, inject, onBeforeUnmount, provide, reactive, type InjectionKey } from 'vue'
import {
  configPath,
  getAt,
  isUnder,
  setAt,
  type ComposerSchema,
  type DraftBlock,
  type TreeError,
} from './tree.ts'

// What a block's form and its fields share: the block's config, read and written by path, and
// the problems at each path. A field claims its path; problems no field claims are listed at the
// top of the block's form, so every error core or the server reports shows somewhere (D76).

export interface BlockFormContext {
  block: () => DraftBlock
  /** The whole draft, for the blocks `$block` and a burndown's range may name. */
  root: () => DraftBlock
  schema: () => ComposerSchema
  /** People to pick in actor conditions, besides "Me". */
  people: () => readonly Principal[]
  get(path: string): unknown
  set(path: string, value: unknown): void
  /** Messages at `path` or under it. */
  errorsAt(path: string): string[]
  /** Messages at `path` itself. */
  errorsExactly(path: string): string[]
  /** Paths fields show errors for: `=path` for that path alone, else it and under it. */
  claimed: Set<string>
}

const key: InjectionKey<BlockFormContext> = Symbol('block form')

export function provideBlockForm(options: {
  block: () => DraftBlock
  root: () => DraftBlock
  blockPath: () => string
  schema: () => ComposerSchema
  people: () => readonly Principal[]
  errors: () => readonly TreeError[]
}): { context: BlockFormContext; unclaimed: () => TreeError[] } {
  const claimed = reactive(new Set<string>())
  const own = computed(() =>
    options.errors().flatMap((e) => {
      const p = configPath(e, options.blockPath())
      return p === null ? [] : [{ path: p, message: e.message }]
    }),
  )
  const context: BlockFormContext = {
    block: options.block,
    root: options.root,
    schema: options.schema,
    people: options.people,
    get: (path) => getAt(options.block().config, path),
    set: (path, value) => {
      setAt(options.block().config, path, value)
    },
    errorsAt: (path) => own.value.filter((e) => isUnder(e.path, path)).map((e) => e.message),
    errorsExactly: (path) => own.value.filter((e) => e.path === path).map((e) => e.message),
    claimed,
  }
  provide(key, context)
  return {
    context,
    // The block's own problems no field shows: its type, children, or config paths no form has.
    unclaimed: () => {
      const blockPath = options.blockPath()
      return options.errors().filter((e) => {
        const p = configPath(e, blockPath)
        if (p === null) return true
        return ![...claimed].some((c) => (c.startsWith('=') ? p === c.slice(1) : isUnder(p, c)))
      })
    },
  }
}

export function useBlockForm(): BlockFormContext {
  const context = inject(key)
  if (!context) throw new Error('A composer field is used outside a block form')
  return context
}

/**
 * A field at `path`: its value, a setter, and its messages. It claims `path` while shown.
 * `exact`: only messages at `path` itself, for a list whose rows are fields of their own.
 */
export function useField<T = unknown>(path: () => string, options: { exact?: boolean } = {}) {
  const form = useBlockForm()
  const claimedPath = options.exact ? `=${path()}` : path()
  form.claimed.add(claimedPath)
  onBeforeUnmount(() => {
    form.claimed.delete(claimedPath)
  })
  return {
    form,
    value: computed({
      get: () => form.get(path()) as T,
      set: (v: T) => {
        form.set(path(), v)
      },
    }),
    error: computed(() =>
      (options.exact ? form.errorsExactly(path()) : form.errorsAt(path())).join(' '),
    ),
  }
}
