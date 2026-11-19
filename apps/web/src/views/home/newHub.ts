import {
  can,
  createHubSchema,
  hubListEntrySchema,
  type CreateHub,
  type HubListEntry,
  type Me,
  type PaletteColor,
} from '@16bit/core'
import { asRequestError, sendJson, type Fetch } from '../../api/client.ts'
import { viewerOf } from '../hub-settings/access.ts'

// Creating a hub from the dashboard (`POST /v1/workspaces/:w/hubs`). Owners and admins only
// (`hub.create`, docs/ROLES.md); the creator becomes the hub's hub admin.

/** Whether the reader may create hubs in this workspace. */
export function canCreateHub(me: Me | null, workspaceId: string): boolean {
  const viewer = viewerOf(me, workspaceId)
  return !!viewer && can(viewer, 'hub.create') === 'allow'
}

/** What the dialog holds. The prefix is typed freely and sent in capitals. */
export interface HubDraft {
  name: string
  idPrefix: string
  color: PaletteColor | null
}

export type HubDraftErrors = Partial<Record<'name' | 'idPrefix' | 'color', string>>

export const PREFIX_HINT =
  'Item IDs start with it, as in ENG-12. A capital letter, then up to 9 capitals or digits. It cannot be changed later.'

/**
 * A prefix from the hub's name: the first three letters of one word, or the initials of
 * several (at most four). Letters outside A to Z are dropped, and so are leading digits, since
 * a prefix starts with a letter. Empty when nothing usable is left.
 */
export function suggestPrefix(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  const raw =
    words.length > 1
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
      : (words[0] ?? '').slice(0, 3)
  return raw.replace(/^[0-9]+/, '').slice(0, 10)
}

/** The first palette colour no hub in the workspace uses yet, else the first. */
export function nextHubColor(
  used: readonly PaletteColor[],
  palette: readonly PaletteColor[],
): PaletteColor {
  const taken = new Set(used)
  return palette.find((c) => !taken.has(c)) ?? palette[0] ?? 'indigo'
}

/**
 * Checks the draft against `createHubSchema` before anything is sent. Returns the request body,
 * or an error per field in the dialog's words.
 */
export function hubRequest(
  draft: HubDraft,
): { ok: true; body: CreateHub } | { ok: false; errors: HubDraftErrors } {
  const errors: HubDraftErrors = {}
  const name = draft.name.trim()
  const idPrefix = draft.idPrefix.trim().toUpperCase()
  if (!name) errors.name = 'Name the hub.'
  else if (name.length > 200) errors.name = 'Use at most 200 characters.'
  if (!idPrefix) errors.idPrefix = 'Choose an ID prefix.'
  else if (!/^[A-Z][A-Z0-9]{0,9}$/.test(idPrefix)) {
    errors.idPrefix = 'Start with a letter, then use up to 9 letters or digits.'
  }
  if (!draft.color) errors.color = 'Choose a colour.'
  if (Object.keys(errors).length > 0 || !draft.color) return { ok: false, errors }
  // The contract has the last word, so a rule added to it later is not skipped here.
  const parsed = createHubSchema.safeParse({ name, color: draft.color, idPrefix })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0]
      if (field === 'name' || field === 'idPrefix' || field === 'color') {
        errors[field] ??= 'Check this value.'
      }
    }
    return { ok: false, errors }
  }
  return { ok: true, body: parsed.data }
}

export type CreateHubResult =
  { ok: true; hub: Extract<HubListEntry, { access: 'granted' }> } | { ok: false; message: string }

/**
 * Sends the create. Nothing is shown as created until the server answers: the reader goes
 * straight to the new hub's settings, which can only open once the hub exists.
 */
export async function createHub(
  workspaceId: string,
  body: CreateHub,
  fetchFn: Fetch = (...args) => fetch(...args),
): Promise<CreateHubResult> {
  try {
    const hub = await sendJson(
      'POST',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/hubs`,
      body,
      hubListEntrySchema,
      fetchFn,
    )
    if (hub.access !== 'granted') {
      return { ok: false, message: 'The server sent an unexpected response.' }
    }
    return { ok: true, hub }
  } catch (thrown) {
    const error = asRequestError(thrown)
    if (error.isNoPermission) {
      return { ok: false, message: 'Your role does not allow creating hubs in this workspace.' }
    }
    if (error.isNotFound) {
      return { ok: false, message: 'This workspace is no longer available.' }
    }
    if (error.code === 'id_taken') {
      return { ok: false, message: 'That hub ID is already used. Try again.' }
    }
    return { ok: false, message: `The hub was not created. ${error.message}` }
  }
}
