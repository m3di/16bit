import { BLOCK_TYPES, invalidViewErrorSchema, type BlockTypeName } from '@16bit/core'
import { computed, ref, shallowRef, watch } from 'vue'
import { asRequestError, type ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { viewRequests, type RequestQueue } from '../root-view/queue.ts'
import { browserTimeZone } from '../root-view/refresh.ts'
import { readableBlocks, readTree } from '../root-view/render-tree.ts'
import {
  parseRawView,
  type RawView,
  type ViewSource,
  type ViewWrites,
} from '../root-view/source.ts'
import type { BlockLoad, DataProblem } from '../root-view/useRootView.ts'
import { defaultConfig } from './defaults.ts'
import {
  addChild,
  checkDraft,
  draftFrom,
  moveBlock,
  newId,
  removeBlock,
  stableJson,
  toTree,
  walk,
  type ComposerSchema,
  type DraftBlock,
  type TreeError,
} from './tree.ts'

// The composer for one folder's root view (D76, D78, Q10): the view as read, a draft the forms
// change, core's checks on every change, and Save (PUT with the version), Reset (DELETE with the
// version) and the preview's data. Saving waits for the server: the draft is the admin's until
// it is saved, so a refusal leaves it as it was and says why.

/** Something to tell the admin about the last save or reset. */
export type ComposerNotice =
  | { tone: 'info'; text: string }
  | { tone: 'error'; text: string }
  /** Someone else saved first. `current` is theirs; Reload puts it in the draft. */
  | { tone: 'conflict'; text: string; current: RawView }

export interface ViewComposerOptions {
  api: ViewSource & ViewWrites
  schema: () => ComposerSchema | null
  queue?: RequestQueue
  timeZone?: string | undefined
}

const sameBlock = (a: DraftBlock, b: { type: string; config: unknown }) =>
  a.type === b.type && stableJson(a.config) === stableJson(b.config)

function refusal(error: ApiRequestError, what: 'save' | 'reset'): string {
  const nothing = what === 'save' ? 'The view was not saved.' : 'The view was not reset.'
  if (error.isNoPermission) return `Only hub admins can change root views. ${nothing}`
  if (error.isNotFound) return `This folder is no longer available. ${nothing}`
  if (error.code === 'network') return `The server could not be reached. ${nothing}`
  return `${nothing} ${error.message}`
}

export function useViewComposer(options: ViewComposerOptions) {
  const { api } = options
  const queue = options.queue ?? viewRequests
  const timeZone = 'timeZone' in options ? options.timeZone : browserTimeZone()

  const folderId = ref<string | null>(null)
  const view = shallowRef<Load<RawView>>({ state: 'loading' })
  const draft = ref<DraftBlock | null>(null)
  const baseline = ref('')
  const selected = ref<string | null>(null)
  const serverErrors = shallowRef<TreeError[]>([])
  const notice = shallowRef<ComposerNotice | null>(null)
  const busy = ref<'save' | 'reset' | null>(null)
  const storedData = shallowRef<Record<string, BlockLoad>>({})
  const dataFailed = ref(false)
  let generation = 0

  const saved = computed(() => (view.value.state === 'ready' ? view.value.data : null))
  const dirty = computed(() => !!draft.value && stableJson(draft.value) !== baseline.value)
  const clientErrors = computed(() => {
    const s = options.schema()
    return draft.value && s ? checkDraft(draft.value, s) : []
  })
  /** Core's problems with the draft, then any the server added on the last save. */
  const errors = computed(() => {
    const seen = new Set<string>()
    return [...clientErrors.value, ...serverErrors.value].filter((e) => {
      const key = `${e.path}\n${e.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
  const blocks = computed(() => (draft.value ? walk(draft.value) : []))

  // A change to the draft answers the server's last word on it.
  watch(
    draft,
    () => {
      serverErrors.value = []
    },
    { deep: true },
  )

  function take(answer: RawView) {
    view.value = { state: 'ready', data: answer }
    draft.value = draftFrom(answer.tree)
    baseline.value = stableJson(draft.value)
    serverErrors.value = []
    if (!selected.value || !walk(draft.value).some((l) => l.block.id === selected.value)) {
      selected.value = draft.value.id
    }
    void loadData(answer)
  }

  /** Reads the folder's view, stored or default. */
  async function load(id: string) {
    const gen = ++generation
    folderId.value = id
    view.value = { state: 'loading' }
    draft.value = null
    selected.value = null
    notice.value = null
    storedData.value = {}
    dataFailed.value = false
    try {
      const answer = await api.view(id)
      if (gen === generation) take(answer)
    } catch (thrown) {
      if (gen === generation) view.value = { state: 'error', error: asRequestError(thrown) }
    }
  }

  /** The stored view's data, for the preview's blocks that are unchanged. */
  async function loadData(v: RawView) {
    const gen = generation
    const data = readableBlocks(readTree(v.tree).page).filter(
      (b) => BLOCK_TYPES[b.type].category === 'data',
    )
    storedData.value = Object.fromEntries(data.map((b) => [b.id, { state: 'loading' }]))
    dataFailed.value = false
    if (data.length === 0) return
    try {
      const answer = await queue.run(() =>
        api.data(v.folderId, { version: v.version, ...(timeZone ? { tz: timeZone } : {}) }),
      )
      if (gen !== generation) return
      storedData.value = Object.fromEntries(
        data.map((b): [string, BlockLoad] => {
          const status = answer.blocks[b.id]
          return [
            b.id,
            { state: 'ready', status: status ?? { status: 'error', error: 'internal' } },
          ]
        }),
      )
    } catch {
      if (gen !== generation) return
      storedData.value = Object.fromEntries(data.map((b) => [b.id, { state: 'failed' }]))
      dataFailed.value = true
    }
  }

  /** The stored blocks by ID, to tell which draft blocks the preview has data for. */
  const storedBlocks = computed(() => {
    const v = saved.value
    if (!v) return new Map<string, { type: string; config: unknown }>()
    return new Map(readableBlocks(readTree(v.tree).page).map((b) => [b.id, b]))
  })

  /** Draft data blocks that differ from the stored ones: their data shows after saving. */
  const unsaved = computed(() => {
    const out = new Set<string>()
    for (const { block } of blocks.value) {
      if (BLOCK_TYPES[block.type].category !== 'data') continue
      const stored = storedBlocks.value.get(block.id)
      if (!stored || !sameBlock(block, stored)) out.add(block.id)
    }
    return out
  })

  const previewProblem = computed<DataProblem>(() => (dataFailed.value ? 'request' : null))

  // ---- editing ---------------------------------------------------------------------------

  function add(parentId: string, type: BlockTypeName): string | null {
    const root = draft.value
    const s = options.schema()
    if (!root || !s || folderId.value === null) return null
    const block: DraftBlock = {
      id: newId(root, type),
      type,
      config: defaultConfig(type, s, folderId.value, root),
      ...(BLOCK_TYPES[type].children.length > 0 ? { children: [] } : {}),
    }
    if (!addChild(root, parentId, block)) return null
    selected.value = block.id
    return block.id
  }

  function remove(id: string) {
    const root = draft.value
    if (!root) return
    const at = walk(root).find((l) => l.block.id === id)
    if (!at?.parent) return
    removeBlock(root, id)
    if (selected.value && !walk(root).some((l) => l.block.id === selected.value)) {
      selected.value = at.parent.id
    }
  }

  function move(id: string, by: -1 | 1) {
    if (draft.value) moveBlock(draft.value, id, by)
  }

  /** Puts the saved view back in the draft. */
  function discard() {
    const v = saved.value
    if (!v) return
    take(v)
    notice.value = null
  }

  // ---- writes ------------------------------------------------------------------------------

  function conflictFrom(error: ApiRequestError): RawView | null {
    if (error.code !== 'conflict' || !error.body) return null
    try {
      return parseRawView((error.body as { current?: unknown }).current)
    } catch {
      return null
    }
  }

  async function save(): Promise<boolean> {
    const v = saved.value
    const root = draft.value
    const id = folderId.value
    const s = options.schema()
    if (!v || !root || id === null || busy.value) return false
    // A description the server cut short may lack what the draft names: let the server judge.
    const cut = s ? Object.values(s.description.truncated).some(Boolean) : false
    if (clientErrors.value.length > 0 && !cut) {
      notice.value = {
        tone: 'error',
        text: `The view was not saved. Fix the ${clientErrors.value.length === 1 ? 'problem' : `${String(clientErrors.value.length)} problems`} marked below first.`,
      }
      return false
    }
    busy.value = 'save'
    notice.value = null
    const gen = generation
    try {
      const answer = await api.put(id, v.version, toTree(root))
      if (gen !== generation) return false
      take(answer)
      notice.value = {
        tone: 'info',
        text: `Saved. The folder opens on this view (version ${String(answer.version)}).`,
      }
      return true
    } catch (thrown) {
      if (gen !== generation) return false
      const error = asRequestError(thrown)
      const current = conflictFrom(error)
      if (current) {
        notice.value = {
          tone: 'conflict',
          current,
          text: 'Someone else changed this view while you were editing. Your changes were not saved. Reload to compose on their version.',
        }
        return false
      }
      const invalid =
        error.code === 'invalid_view' ? invalidViewErrorSchema.safeParse(error.body) : null
      if (invalid?.success) {
        serverErrors.value = invalid.data.errors
        const n = invalid.data.errors.length
        notice.value = {
          tone: 'error',
          text: `The view was not saved. The server found ${n === 1 ? 'a problem' : `${String(n)} problems`}, marked below.`,
        }
        return false
      }
      notice.value = { tone: 'error', text: refusal(error, 'save') }
      return false
    } finally {
      if (gen === generation) busy.value = null
    }
  }

  /** Back to the default view (D76). A 404 means it already is: read it again (lead note). */
  async function reset(): Promise<boolean> {
    const v = saved.value
    const id = folderId.value
    if (!v?.stored || id === null || busy.value) return false
    busy.value = 'reset'
    notice.value = null
    const gen = generation
    let text = 'Reset. The folder opens on its default view.'
    try {
      await api.reset(id, v.version)
    } catch (thrown) {
      const error = asRequestError(thrown)
      const current = conflictFrom(error)
      if (gen !== generation) return false
      busy.value = null
      if (current) {
        notice.value = {
          tone: 'conflict',
          current,
          text: 'Someone else changed this view meanwhile, so it was not reset. Reload to see their version.',
        }
        return false
      }
      if (!error.isNotFound) {
        notice.value = { tone: 'error', text: refusal(error, 'reset') }
        return false
      }
      text = 'This folder already opens on its default view.'
    }
    if (gen !== generation) return false
    busy.value = null
    await load(id)
    notice.value = { tone: 'info', text }
    return true
  }

  /** After a conflict: compose on the version someone else saved. */
  function reload() {
    const n = notice.value
    if (n?.tone !== 'conflict') return
    take(n.current)
    notice.value = { tone: 'info', text: `Reloaded version ${String(n.current.version)}.` }
  }

  return {
    folderId,
    view,
    saved,
    draft,
    selected,
    dirty,
    errors,
    clientErrors,
    serverErrors,
    blocks,
    notice,
    busy,
    storedData,
    unsaved,
    previewProblem,
    load,
    add,
    remove,
    move,
    discard,
    save,
    reset,
    reload,
    retryData: () => {
      if (saved.value) void loadData(saved.value)
    },
    dismiss: () => {
      notice.value = null
    },
  }
}

export type ViewComposer = ReturnType<typeof useViewComposer>
