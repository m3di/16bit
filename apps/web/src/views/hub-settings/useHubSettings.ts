import {
  attributeConflictErrorSchema,
  attributeSchema,
  confirmRequiredErrorSchema,
  folderAttributesConflictErrorSchema,
  folderAttributesResultSchema,
  folderConflictErrorSchema,
  folderSchema,
  hubDescriptionSchema,
  hubPageSchema,
  type Attribute,
  type CreateAttribute,
  type CreateFolder,
  type Folder,
  type FolderAttributes,
  type FolderAttributesResult,
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
 * How a schema write ended. `confirm`: the write would clear values on `affected` items and
 * must be sent again with that count (D51). `conflict`: someone else changed the thing first;
 * the page already shows their version. `refused`: anything else, with a sentence to show.
 */
export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'confirm'; affected: number }
  | { ok: false; kind: 'conflict'; message: string }
  | { ok: false; kind: 'refused'; message: string }

const CONFLICT = {
  folder:
    'Someone else changed this folder while you were editing. It now shows their version; your change was not saved.',
  folderAttributes:
    'Someone else changed the attributes of this folder while you were editing. They now show their version; your change was not saved.',
  attribute:
    'Someone else changed this attribute while you were editing. It now shows their version; your change was not saved.',
} as const

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
  async function write<T>(
    thing: 'folder' | 'attribute',
    run: () => Promise<T>,
    onConflict: (body: unknown) => string | null,
  ): Promise<WriteResult<T>> {
    try {
      return { ok: true, data: await run() }
    } catch (raw) {
      const error = asRequestError(raw)
      if (error.code === 'confirm_required') {
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
    const result = await write(
      'attribute',
      () => sendJson('PATCH', path, body, attributeSchema, fetchFn),
      attributeConflict,
    )
    if (result.ok) putAttribute(result.data)
    return result
  }

  async function deleteAttribute(attribute: Attribute, confirm?: number) {
    const query = new URLSearchParams({ version: String(attribute.version) })
    if (confirm !== undefined) query.set('confirm', String(confirm))
    const path = `${ws}/attributes/${encodeURIComponent(attribute.id)}?${query.toString()}`
    const result = await write(
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
    deleteAttribute,
  }
}

export type HubSettings = ReturnType<typeof useHubSettings>
