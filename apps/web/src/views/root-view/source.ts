import {
  defaultViewTree,
  viewDataSchema,
  viewSchema,
  type HubDescription,
  type View,
  type ViewData,
} from '@16bit/core'
import { inject, provide, type InjectionKey } from 'vue'
import { getJson, type Fetch } from '../../api/client.ts'

// Where a folder's root view and its data come from (D76, D83). The page only talks to a
// `ViewSource`, so the routes plug in without touching the renderer.

/**
 * A view as read, its tree not yet checked: `parseViewTree` runs in the renderer, which can
 * still show the readable blocks of a tree this client can't fully read (a block type added
 * after this build). Otherwise `View`.
 */
export type RawView = Omit<View, 'tree'> & { tree: unknown }

export interface ViewDataRequest {
  /** The tree version the client holds; `0` for the default. */
  version: number
  /** Only these blocks, for a refetch. All data blocks when left out. */
  blocks?: readonly string[]
  /** The reader's time zone (D81). */
  tz?: string
}

export interface ViewSource {
  /**
   * The folder's view, stored or the default. Throws an `ApiRequestError`. May answer at once
   * (no request), so the default view shows without a loading frame.
   */
  view(folderId: string): RawView | Promise<RawView>
  /** Every data block's status in one snapshot, as of `seq`. Throws an `ApiRequestError`. */
  data(folderId: string, request: ViewDataRequest): Promise<ViewData>
}

const workspacePath = (workspaceId: string, folderId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/folders/${encodeURIComponent(folderId)}/view`

/** The query string of a view-data request. */
export function viewDataQuery(request: ViewDataRequest): string {
  const query = new URLSearchParams({ version: String(request.version) })
  if (request.blocks && request.blocks.length > 0) query.set('blocks', request.blocks.join(','))
  if (request.tz) query.set('tz', request.tz)
  return query.toString()
}

/** The view routes: `GET …/folders/:folderId/view` and `GET …/view/data`. */
export function httpViewSource(workspaceId: string, fetchFn: Fetch): ViewSource {
  return {
    view: (folderId) =>
      getJson(workspacePath(workspaceId, folderId), { parse: parseRawView }, fetchFn),
    data: (folderId, request) =>
      getJson(
        `${workspacePath(workspaceId, folderId)}/data?${viewDataQuery(request)}`,
        viewDataSchema,
        fetchFn,
      ),
  }
}

const viewMetaSchema = viewSchema.omit({ tree: true })

/** Checks everything about a view but its tree, which is kept as sent. */
export function parseRawView(body: unknown): RawView {
  if (typeof body !== 'object' || body === null) throw new Error('A view is an object')
  const { tree, ...meta } = body as Record<string, unknown>
  return { ...viewMetaSchema.parse(meta), tree }
}

/**
 * No folder has a stored view: every folder answers its default (D76) at once, with no request.
 * Used until the view routes exist; then `httpViewSource` replaces it.
 */
export function defaultViewSource(description: () => HubDescription | null): ViewSource {
  return {
    view(folderId) {
      const d = description()
      const folder = d?.hub.id === folderId ? d.hub : d?.folders.find((f) => f.id === folderId)
      return {
        folderId,
        hubId: d?.hub.id ?? folderId,
        stored: false,
        version: 0,
        tree: defaultViewTree(folderId, { viewsOnly: folder?.viewsOnly === true }),
        updatedAt: null,
        updatedBy: null,
        seq: 0,
      }
    },
    // The default view of a folder with items is today's folder screen, which reads its own
    // items; nothing asks for view data while every view is a default.
    data: (folderId) => Promise.resolve({ folderId, version: 0, blocks: {}, seq: 0 }),
  }
}

const sourceKey: InjectionKey<ViewSource> = Symbol('view source')

/** Lets a page (or a test) choose where views come from. */
export const provideViewSource = (source: ViewSource) => {
  provide(sourceKey, source)
}

/** The provided source, else `fallback`. */
export const useViewSource = (fallback: () => ViewSource): ViewSource =>
  inject(sourceKey, fallback, true)
