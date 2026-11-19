import type { Me, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { person } from '../../session/fixtures.test-utils.ts'
import { description } from './fixtures.test-utils.ts'
import { folderColumns } from './useHub.ts'
import { canWriteItems, newItemValues } from './newItem.ts'

const as = (workspaceRole: WorkspaceRole): Me => ({
  ...(person as Extract<Me, { kind: 'person' }>),
  memberships: [{ workspace: { id: 'w', name: 'W' }, principalId: 'p', workspaceRole }],
})

describe('canWriteItems', () => {
  it('follows item.write: hub admins and editors, not commenters or viewers', () => {
    expect(canWriteItems(as('member'), 'w', 'hub_admin')).toBe(true)
    expect(canWriteItems(as('member'), 'w', 'editor')).toBe(true)
    expect(canWriteItems(as('owner'), 'w', 'commenter')).toBe(false)
    expect(canWriteItems(as('admin'), 'w', 'viewer')).toBe(false)
  })

  it('refuses a reader who is not a member of the workspace, or signed out', () => {
    expect(canWriteItems(as('owner'), 'other', 'editor')).toBe(false)
    expect(canWriteItems(null, 'w', 'editor')).toBe(false)
  })

  it('is unknown until both the reader and the hub role are', () => {
    expect(canWriteItems(undefined, 'w', 'editor')).toBeNull()
    expect(canWriteItems(as('owner'), 'w', undefined)).toBeNull()
  })
})

describe('newItemValues', () => {
  const columns = folderColumns(description, 'bld')

  it('stops a create that leaves a required attribute empty', () => {
    expect(newItemValues(columns, {})).toEqual({
      ok: false,
      errors: { title: 'A value is required' },
    })
    // A field set and then cleared counts as empty too.
    expect(newItemValues(columns, { title: null, points: 3 })).toEqual({
      ok: false,
      errors: { title: 'A value is required' },
    })
  })

  it('reports a value of the wrong shape against its attribute', () => {
    const result = newItemValues(columns, { title: 'Ship it', points: 'many' })
    expect(result.ok).toBe(false)
    expect(Object.keys((result as { errors: object }).errors)).toEqual(['points'])
  })

  it('sends only the fields that are set, once the required ones are', () => {
    expect(newItemValues(columns, { title: 'Ship it', stage: null, points: 2 })).toEqual({
      ok: true,
      values: { title: 'Ship it', points: 2 },
    })
  })

  it('lets a folder without required attributes create an empty item', () => {
    expect(newItemValues([], {})).toEqual({ ok: true, values: {} })
  })
})
