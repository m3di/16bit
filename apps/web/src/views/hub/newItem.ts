import {
  can,
  validateItemValues,
  type FolderAttributeDefinition,
  type HubRole,
  type ItemValues,
  type Me,
} from '@16bit/core'
import { viewerOf } from '../hub-settings/access.ts'

// Creating an item from the folder view: who may, and what is sent.

/**
 * Whether the reader may add and change items here (`item.write`, docs/ROLES.md). The hub role
 * from the hub description is already capped by the workspace role, so it stands in for the
 * grant. `null` while the reader is not known yet, so neither the action nor the read-only
 * note shows before it is.
 */
export function canWriteItems(
  me: Me | null | undefined,
  workspaceId: string,
  hubRole: HubRole | undefined,
): boolean | null {
  if (me === undefined || hubRole === undefined) return null
  const viewer = viewerOf(me, workspaceId)
  return !!viewer && can(viewer, 'item.write', { hubGrant: hubRole }) === 'allow'
}

/**
 * The values to send for a new item, checked against the folder's attributes first: a required
 * attribute left empty, or a value of the wrong shape, stops the create before any request.
 * Unset optional fields are left out; the server stores no value for them.
 */
export function newItemValues(
  columns: readonly FolderAttributeDefinition[],
  values: ItemValues,
): { ok: true; values: ItemValues } | { ok: false; errors: Record<string, string> } {
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null))
  const result = validateItemValues(columns, filled)
  if (!result.ok) {
    return {
      ok: false,
      errors: Object.fromEntries(result.errors.map((e) => [e.attributeId, e.message])),
    }
  }
  return { ok: true, values: result.values }
}
