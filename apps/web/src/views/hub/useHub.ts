import {
  hubDescriptionSchema,
  type Folder,
  type FolderAttributeDefinition,
  type HubDescription,
} from '@16bit/core'
import { computed, ref } from 'vue'
import { asRequestError, getJson, type Fetch } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

export interface FolderEntry {
  folder: Folder
  /** 0 for the hub itself and its direct children. */
  depth: number
}

/** Folders in tree order: the hub first, then each folder followed by its children, by name. */
export function folderTree(description: HubDescription): FolderEntry[] {
  const children = new Map<string, Folder[]>()
  for (const folder of description.folders) {
    const parent = folder.parentId ?? description.hub.id
    children.set(parent, [...(children.get(parent) ?? []), folder])
  }
  const out: FolderEntry[] = [{ folder: description.hub, depth: 0 }]
  const seen = new Set([description.hub.id])
  const walk = (parentId: string, depth: number) => {
    for (const folder of children.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue
      seen.add(folder.id)
      out.push({ folder, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(description.hub.id, 0)
  // A folder whose parent is missing from the response still gets listed.
  for (const folder of description.folders) {
    if (!seen.has(folder.id)) out.push({ folder, depth: 0 })
  }
  return out
}

/** The attributes a folder shows, in `position` order, with its `required` flags. */
export function folderColumns(
  description: HubDescription,
  folderId: string,
): FolderAttributeDefinition[] {
  const attributes = new Map(description.attributes.map((a) => [a.id, a]))
  return description.folderAttributes
    .filter((fa) => fa.folderId === folderId)
    .sort((a, b) => a.position - b.position)
    .flatMap((fa) => {
      const attribute = attributes.get(fa.attributeId)
      return attribute ? [{ attribute, required: fa.required }] : []
    })
}

/** A sentence saying which lists the server cut short, or `''` when nothing was cut. */
export function truncatedNote(description: HubDescription): string {
  const t = description.truncated
  const parts = [t.folders && 'folders', (t.attributes || t.folderAttributes) && 'fields']
  const cut = parts.filter(Boolean).join(' and ')
  return cut ? `This hub has more ${cut} than can be shown here.` : ''
}

/** A hub's description: its folders and attributes (`GET /v1/workspaces/:w/hubs/:h`). */
export function useHub(
  workspaceId: string,
  hubId: string,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
  const hub = ref<Load<HubDescription>>({ state: 'loading' })
  let loading: Promise<void> | null = null

  async function fetchHub() {
    hub.value = { state: 'loading' }
    const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/hubs/${encodeURIComponent(hubId)}`
    try {
      hub.value = { state: 'ready', data: await getJson(path, hubDescriptionSchema, fetchFn) }
    } catch (error) {
      hub.value = { state: 'error', error: asRequestError(error) }
    }
  }

  /** Loads the hub. A second call while one is running joins it. */
  function load(): Promise<void> {
    loading ??= fetchHub().finally(() => {
      loading = null
    })
    return loading
  }

  const tree = computed(() => (hub.value.state === 'ready' ? folderTree(hub.value.data) : []))
  return { hub, tree, load }
}
