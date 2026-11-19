import {
  attributeConflictErrorSchema,
  attributeUsageSchema,
  attributeSchema,
  confirmRequiredErrorSchema,
  folderAttributesConflictErrorSchema,
  folderAttributesResultSchema,
  folderConflictErrorSchema,
  folderSchema,
  hubConflictErrorSchema,
  hubDescriptionSchema,
  hubSchema,
  hubPageSchema,
  type Attribute,
  type AttributeUsage,
  type CreateAttribute,
  type CreateFolder,
  type Folder,
  type FolderAttributes,
  type FolderAttributesResult,
  type Hub,
  type HubDescription,
  type HubListEntry,
  type SelectOption,
} from '@16bit/core'
import { ref } from 'vue'
import {
  asRequestError,
  getAllPages,
  getJson,
  noContent,
  putJson,
  sendJson,
  type ApiRequestError,
  type Fetch,
} from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { READ_ONLY_REASON } from './schema.ts'

/**
 * How a schema write ended. `conflict`: someone else changed the thing first; the page already
 * shows their version. `refused`: anything else, with a sentence to show.
 */
export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'conflict'; message: string }
  | { ok: false; kind: 'refused'; message: string }

/**
 * A write that can clear item values: changing an attribute's options or deleting it. It may
 * also end in `confirm`: the write would clear values on `affected` items and must be sent
 * again with that count (D51). No other schema route answers `confirm_required`.
 */
export type ConfirmableResult<T> = WriteResult<T> | { ok: false; kind: 'confirm'; affected: number }

const CONFLICT = {
  folder:
    'Someone else changed this folder while you were editing. It now shows their version; your change was not saved.',
  folderAttributes:
    'Someone else changed the attributes of this folder while you were editing. They now show their version; your change was not saved.',
  attribute:
    'Someone else changed this attribute while you were editing. It now shows their version; your change was not saved.',
  hub: 'Someone else changed this hub while you were editing. It now shows their version; your change was not saved.',
} as const

/** The fields of the hub that general settings change (`PATCH /hubs/:hubId`). */
export type HubChange = Partial<Pick<Hub, 'name' | 'color' | 'titleAttributeId'>>
type HubField = keyof HubChange
const HUB_FIELDS: readonly HubField[] = ['name', 'color', 'titleAttributeId']

/** Why a hub write or delete was refused, in words. */
export function hubRefusal(error: ApiRequestError, what: 'change' | 'delete'): string {
  if (error.isNoPermission) {
    return what === 'delete'
      ? 'Your role does not allow deleting this hub.'
      : 'Only hub admins can change this hub. Your change was not saved.'
  }
  if (error.isNotFound) return 'This hub is no longer available.'
  if (error.code === 'not_empty')
    return 'The hub still holds items or folders, so it was not deleted.'
  if (error.code === 'in_use')
    return 'A relation attribute in another hub links to this hub. Delete that attribute first; the hub was not deleted.'
  if (error.code === 'network') return 'The server could not be reached. Nothing was changed.'
  return what === 'delete'
    ? `The hub was not deleted. ${error.message}`
    : `Your change was not saved. ${error.message}`
}

/** A refusal in words. The server's message is the fallback for a 400. */
export function refusalMessage(error: ApiRequestError, thing: 'folder' | 'attribute'): string {
  if (error.isNoPermission) return READ_ONLY_REASON
  if (error.isNotFound) return `This ${thing} is no longer available. The list has been read again.`
  if (error.code === 'not_empty')
    return 'This folder still holds items or folders, so it was not deleted.'
  if (error.code === 'network') return 'The server could not be reached. Nothing was changed.'
  return error.message
}

/**
 * Hub settings for folders and attributes: the hub description (`GET /hubs/:hubId`) and every
 * schema write route. Writes wait for the server inside their dialog, which keeps the
 * reader's input on a refusal; the page then applies the answer. A version conflict puts the
 * server's `current` on the page at once, so what is shown is never older than what was refused.
 */
export function useHubSettings(
  workspaceId: string,
  hubId: string,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
  const ws = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const hubPath = `${ws}/hubs/${encodeURIComponent(hubId)}`
  const hub = ref<Load<HubDescription>>({ state: 'loading' })
  /** Hubs a relation may target: those the reader holds a grant on (`relation.target`). */
  const targets = ref<Load<HubListEntry[]>>({ state: 'loading' })
  let generation = 0

  /** Reads the hub. `keep` leaves the current one on screen while it is read again. */
  async function load(options: { keep?: boolean } = {}) {
    const gen = ++generation
    const keep = options.keep === true && hub.value.state === 'ready'
    if (!keep) hub.value = { state: 'loading' }
    try {
      const data = await getJson(hubPath, hubDescriptionSchema, fetchFn)
      if (gen === generation) hub.value = { state: 'ready', data }
    } catch (error) {
      if (gen === generation && !keep) hub.value = { state: 'error', error: asRequestError(error) }
    }
  }

  async function loadTargets() {
    if (targets.value.state === 'ready') return
    targets.value = { state: 'loading' }
    try {
      const list = await getAllPages(`${ws}/hubs`, hubPageSchema, fetchFn)
      targets.value = { state: 'ready', data: list.filter((h) => h.access === 'granted') }
    } catch (error) {
      targets.value = { state: 'error', error: asRequestError(error) }
    }
  }

  const data = () => (hub.value.state === 'ready' ? hub.value.data : null)

  // ---- local updates from answers ---------------------------------------------------------

  function putFolder(folder: Folder) {
    const d = data()
    if (!d) return
    if (folder.id === d.hub.id) {
      d.hub = { ...d.hub, ...folder, parentId: null }
      return
    }
    const i = d.folders.findIndex((f) => f.id === folder.id)
    if (i === -1) d.folders.push(folder)
    else d.folders[i] = folder
    d.folders.sort((a, b) => a.name.localeCompare(b.name))
  }

  function putFolderAttributes(result: FolderAttributes) {
    const d = data()
    if (!d) return
    putFolder(result.folder)
    d.folderAttributes = [
      ...d.folderAttributes.filter((fa) => fa.folderId !== result.folder.id),
      ...result.attributes,
    ]
  }

  function putAttribute(attribute: Attribute) {
    const d = data()
    if (!d) return
    const i = d.attributes.findIndex((a) => a.id === attribute.id)
    if (i === -1) d.attributes.push(attribute)
    else d.attributes[i] = attribute
  }

  /** Runs a write; maps 409s and refusals. A 404 reads the hub again: the thing is gone. */
  async function attempt<T>(
    thing: 'folder' | 'attribute',
    run: () => Promise<T>,
    onConflict: (body: unknown) => string | null,
    confirmable: boolean,
  ): Promise<ConfirmableResult<T>> {
    try {
      return { ok: true, data: await run() }
    } catch (raw) {
      const error = asRequestError(raw)
      if (confirmable && error.code === 'confirm_required') {
        const parsed = confirmRequiredErrorSchema.safeParse(error.body)
        if (parsed.success) return { ok: false, kind: 'confirm', affected: parsed.data.affected }
      }
      if (error.code === 'conflict') {
        const message = onConflict(error.body)
        if (message) return { ok: false, kind: 'conflict', message }
      }
      if (error.isNotFound) void load({ keep: true })
      return { ok: false, kind: 'refused', message: refusalMessage(error, thing) }
    }
  }

  /** A write that never needs a confirm: a stray `confirm_required` is a plain refusal. */
  const write = <T>(
    thing: 'folder' | 'attribute',
    run: () => Promise<T>,
    onConflict: (body: unknown) => string | null,
  ) => attempt(thing, run, onConflict, false) as Promise<WriteResult<T>>

  const writeConfirmable = <T>(
    thing: 'folder' | 'attribute',
    run: () => Promise<T>,
    onConflict: (body: unknown) => string | null,
  ) => attempt(thing, run, onConflict, true)

  const folderConflict = (body: unknown) => {
    const parsed = folderConflictErrorSchema.safeParse(body)
    if (!parsed.success) return null
    putFolder(parsed.data.current)
    return CONFLICT.folder
  }

  const attributeConflict = (body: unknown) => {
    const parsed = attributeConflictErrorSchema.safeParse(body)
    if (!parsed.success) return null
    putAttribute(parsed.data.current)
    return CONFLICT.attribute
  }

  // ---- folders ----------------------------------------------------------------------------

  async function createFolder(input: CreateFolder) {
    const result = await write(
      'folder',
      () => sendJson('POST', `${hubPath}/folders`, input, folderSchema, fetchFn),
      () => null,
    )
    if (result.ok) putFolder(result.data)
    return result
  }

  async function updateFolder(
    folder: Folder,
    change: { name?: string; color?: Folder['color']; parentId?: string },
  ) {
    const path = `${ws}/folders/${encodeURIComponent(folder.id)}`
    const result = await write(
      'folder',
      () => sendJson('PATCH', path, { version: folder.version, ...change }, folderSchema, fetchFn),
      folderConflict,
    )
    if (result.ok) putFolder(result.data)
    return result
  }

  async function deleteFolder(folder: Folder) {
    const path = `${ws}/folders/${encodeURIComponent(folder.id)}?version=${String(folder.version)}`
    const result = await write(
      'folder',
      () => sendJson('DELETE', path, undefined, noContent, fetchFn),
      folderConflict,
    )
    const d = data()
    if (result.ok && d) {
      d.folders = d.folders.filter((f) => f.id !== folder.id)
      d.folderAttributes = d.folderAttributes.filter((fa) => fa.folderId !== folder.id)
    }
    return result
  }

  /**
   * `PUT /folders/:folderId/attributes`. With `dryRun` nothing is saved: the answer says how
   * many items would leave each required attribute empty (D51), and the page is left alone.
   */
  async function setFolderAttributes(
    folder: Folder,
    attributes: { attributeId: string; required: boolean }[],
    dryRun: boolean,
  ): Promise<WriteResult<FolderAttributesResult>> {
    const path = `${ws}/folders/${encodeURIComponent(folder.id)}/attributes`
    const result = await write(
      'folder',
      () =>
        putJson(
          path,
          { version: folder.version, dryRun, attributes },
          folderAttributesResultSchema,
          fetchFn,
        ),
      (body) => {
        const parsed = folderAttributesConflictErrorSchema.safeParse(body)
        if (!parsed.success) return null
        putFolderAttributes(parsed.data.current)
        return CONFLICT.folderAttributes
      },
    )
    if (result.ok && !dryRun) putFolderAttributes(result.data)
    return result
  }

  // ---- attributes -------------------------------------------------------------------------

  async function createAttribute(input: CreateAttribute) {
    const result = await write(
      'attribute',
      () => sendJson('POST', `${hubPath}/attributes`, input, attributeSchema, fetchFn),
      () => null,
    )
    if (result.ok) putAttribute(result.data)
    return result
  }

  /** Name and options only (D51). `confirm` is the count from a `confirm` answer. */
  async function updateAttribute(
    attribute: Attribute,
    change: { name?: string; options?: SelectOption[] },
    confirm?: number,
  ) {
    const path = `${ws}/attributes/${encodeURIComponent(attribute.id)}`
    const body = {
      version: attribute.version,
      ...change,
      ...(confirm === undefined ? {} : { confirm }),
    }
    const result = await writeConfirmable(
      'attribute',
      () => sendJson('PATCH', path, body, attributeSchema, fetchFn),
      attributeConflict,
    )
    if (result.ok) putAttribute(result.data)
    return result
  }

  /**
   * How many items hold each option of a select or multi-select (`hub.manageSchema`), for
   * the options editor. Throws the request error; the caller shows it.
   */
  function attributeUsage(attribute: Attribute): Promise<AttributeUsage> {
    const path = `${ws}/attributes/${encodeURIComponent(attribute.id)}/usage`
    return getJson(path, attributeUsageSchema, fetchFn)
  }

  async function deleteAttribute(attribute: Attribute, confirm?: number) {
    const query = new URLSearchParams({ version: String(attribute.version) })
    if (confirm !== undefined) query.set('confirm', String(confirm))
    const path = `${ws}/attributes/${encodeURIComponent(attribute.id)}?${query.toString()}`
    const result = await writeConfirmable(
      'attribute',
      () => sendJson('DELETE', path, undefined, noContent, fetchFn),
      attributeConflict,
    )
    const d = data()
    if (result.ok && d) {
      d.attributes = d.attributes.filter((a) => a.id !== attribute.id)
      d.folderAttributes = d.folderAttributes.filter((fa) => fa.attributeId !== attribute.id)
      if (d.hub.titleAttributeId === attribute.id) d.hub = { ...d.hub, titleAttributeId: null }
      // Detaching moved the versions of the folders that showed it: read them again.
      void load({ keep: true })
    }
    return result
  }

  // ---- the hub itself --------------------------------------------------------------------

  /** Why the last hub change was refused, shown in the general section until replaced. */
  const hubNotice = ref<string | null>(null)
  /** Hub changes sent and not yet answered. */
  const hubSaving = ref(0)
  // The last value of each field the server is known to hold while a change to it is in
  // flight, and the latest change per field, so a late answer never undoes a newer choice.
  const confirmedHub = new Map<HubField, unknown>()
  const latestHub = new Map<HubField, number>()
  let hubSeq = 0
  // Hub writes go one at a time: each sends the version the previous answer left.
  let hubQueue: Promise<unknown> = Promise.resolve()
  // A conflict drops the changes queued behind it: they were made on the version it replaced.
  let hubEpoch = 0

  function setHubFields(change: HubChange) {
    const d = data()
    if (d) d.hub = { ...d.hub, ...change }
  }

  /**
   * Shows `change` at once, then sends it. A refusal puts back the last value the server held,
   * unless a newer change to that field is on its way; a conflict shows the server's hub.
   */
  function updateHub(change: HubChange): Promise<WriteResult<Hub>> {
    const d = data()
    if (!d)
      return Promise.resolve({ ok: false, kind: 'refused', message: 'The hub is not loaded.' })
    const fields = HUB_FIELDS.filter((f) => f in change)
    const seq = ++hubSeq
    const epoch = hubEpoch
    for (const f of fields) {
      if (!confirmedHub.has(f)) confirmedHub.set(f, d.hub[f])
      latestHub.set(f, seq)
    }
    setHubFields(change)
    hubNotice.value = null
    hubSaving.value++

    const run = async (): Promise<WriteResult<Hub>> => {
      const now = data()
      if (!now || epoch !== hubEpoch) {
        return { ok: false, kind: 'conflict', message: CONFLICT.hub }
      }
      try {
        const saved = await sendJson(
          'PATCH',
          hubPath,
          { version: now.hub.version, ...change },
          hubSchema,
          fetchFn,
        )
        const shown: HubChange = {}
        for (const f of fields) {
          if (latestHub.get(f) === seq) {
            latestHub.delete(f)
            confirmedHub.delete(f)
            Object.assign(shown, { [f]: saved[f] })
          } else {
            confirmedHub.set(f, saved[f])
          }
        }
        const latest = data()
        if (latest) {
          latest.hub = {
            ...latest.hub,
            ...shown,
            version: saved.version,
            itemCount: saved.itemCount,
          }
        }
        return { ok: true, data: saved }
      } catch (raw) {
        const error = asRequestError(raw)
        const conflict =
          error.code === 'conflict' ? hubConflictErrorSchema.safeParse(error.body) : null
        if (conflict?.success) {
          hubEpoch++
          latestHub.clear()
          confirmedHub.clear()
          const latest = data()
          if (latest) latest.hub = conflict.data.current
          hubNotice.value = CONFLICT.hub
          return { ok: false, kind: 'conflict', message: CONFLICT.hub }
        }
        const back: HubChange = {}
        for (const f of fields) {
          if (latestHub.get(f) !== seq) continue
          latestHub.delete(f)
          Object.assign(back, { [f]: confirmedHub.get(f) })
          confirmedHub.delete(f)
        }
        setHubFields(back)
        const message = hubRefusal(error, 'change')
        hubNotice.value = message
        if (error.isNotFound || (error.isNoPermission && !error.isUnauthorized)) {
          void load({ keep: true })
        }
        return { ok: false, kind: 'refused', message }
      }
    }

    const result = hubQueue.then(run).finally(() => {
      hubSaving.value--
    })
    hubQueue = result.catch(() => undefined)
    return result
  }

  /**
   * Deletes the hub (D52). Waits for the answer, as its confirm dialog does. A conflict reads
   * the hub again, so the counts and version on the page are the server's.
   */
  async function deleteHub(): Promise<WriteResult<undefined>> {
    const d = data()
    if (!d) return { ok: false, kind: 'refused', message: 'The hub is not loaded.' }
    const path = `${hubPath}?version=${String(d.hub.version)}`
    try {
      await sendJson('DELETE', path, undefined, noContent, fetchFn)
      return { ok: true, data: undefined }
    } catch (raw) {
      const error = asRequestError(raw)
      if (error.code === 'conflict') {
        const parsed = hubConflictErrorSchema.safeParse(error.body)
        const latest = data()
        if (parsed.success && latest) latest.hub = parsed.data.current
        void load({ keep: true })
        return {
          ok: false,
          kind: 'conflict',
          message: 'Someone else changed this hub meanwhile. Check it again before deleting.',
        }
      }
      if (error.code === 'not_empty') void load({ keep: true })
      return { ok: false, kind: 'refused', message: hubRefusal(error, 'delete') }
    }
  }

  function dismissHubNotice() {
    hubNotice.value = null
  }

  return {
    hub,
    targets,
    load,
    loadTargets,
    createFolder,
    updateFolder,
    deleteFolder,
    setFolderAttributes,
    createAttribute,
    updateAttribute,
    attributeUsage,
    deleteAttribute,
    hubNotice,
    hubSaving,
    updateHub,
    deleteHub,
    dismissHubNotice,
  }
}

export type HubSettings = ReturnType<typeof useHubSettings>
