import { attributeSchema, type AttributeTypeName } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { ATTRIBUTE_TYPE_ORDER, PALETTE_COLORS } from '../../ui/index.ts'
import { description, HUB, meAs, WS } from './fixtures.test-utils.ts'
import {
  buildCreateAttribute,
  canManageSchema,
  deleteBlockedReason,
  descendantIds,
  emptyDraft,
  folderActions,
  nextFolderColor,
  parentChoices,
  requiredEmptyText,
  settingsTree,
  sidebarActions,
  strippedValuesMessage,
  usedIn,
  type AttributeDraft,
} from './schema.ts'

describe('canManageSchema (hub.manageSchema)', () => {
  it('allows hub admins only, whatever the workspace role', () => {
    expect(canManageSchema(meAs('member'), WS, 'hub_admin')).toBe(true)
    expect(canManageSchema(meAs('owner'), WS, 'hub_admin')).toBe(true)
    expect(canManageSchema(meAs('owner'), WS, 'editor')).toBe(false)
    expect(canManageSchema(meAs('admin'), WS, 'viewer')).toBe(false)
    expect(canManageSchema(meAs('member'), WS, 'commenter')).toBe(false)
  })

  it('refuses without a session or membership', () => {
    expect(canManageSchema(null, WS, 'hub_admin')).toBe(false)
    expect(canManageSchema(meAs('owner'), 'other', 'hub_admin')).toBe(false)
  })
})

describe('the folder tree', () => {
  it('puts the hub first and indents folders under it', () => {
    expect(settingsTree(description()).map((e) => [e.folder.name, e.depth])).toEqual([
      ['Build', 0],
      ['Backlog', 1],
      ['Sprints', 1],
      ['Sprint 1', 2],
    ])
  })

  it('never offers a folder itself or a folder under it as its new parent', () => {
    const d = description()
    expect([...descendantIds(d, 'sprints')].sort()).toEqual(['sprint-1', 'sprints'])
    expect(parentChoices(d, 'sprints').map((c) => c.value)).toEqual([HUB, 'backlog'])
    expect(parentChoices(d, null).map((c) => c.value)).toEqual([
      HUB,
      'backlog',
      'sprints',
      'sprint-1',
    ])
    expect(parentChoices(d, null)[3]?.label).toBe('– – Sprint 1')
  })

  it('says why a folder cannot be deleted yet (D52)', () => {
    const d = description()
    const f = (id: string) => {
      const found = d.folders.find((x) => x.id === id)
      if (!found) throw new Error(id)
      return found
    }
    expect(deleteBlockedReason(d, f('backlog'))).toBe('It still holds items.')
    expect(deleteBlockedReason(d, f('sprints'))).toBe('It still holds folders.')
    expect(deleteBlockedReason(d, f('sprint-1'))).toBe('')
    expect(deleteBlockedReason(d, d.hub)).toMatch(/danger zone/)
  })

  it("gives every folder the settings menu, and the hub's root only its two entries", () => {
    const d = description()
    const keys = (id: string) => {
      const found = id === d.hub.id ? d.hub : d.folders.find((x) => x.id === id)
      if (!found) throw new Error(id)
      return folderActions(d, found)
    }
    expect(keys(d.hub.id).map((a) => a.label)).toEqual(['Attributes', 'New folder inside'])
    expect(keys('sprint-1').map((a) => a.label)).toEqual([
      'Rename, recolour or move',
      'Attributes',
      'New folder inside',
      'Delete folder',
    ])
    expect(keys('sprint-1').at(-1)).toMatchObject({ danger: true, disabled: false, reason: '' })
    // Not empty: disabled, with the same reason as in settings (D52).
    expect(keys('backlog').at(-1)).toMatchObject({
      disabled: true,
      reason: 'It still holds items.',
    })
  })

  it('adds Hub settings to the root of the sidebar menu, for those who see the settings link', () => {
    const d = description()
    const backlog = d.folders.find((x) => x.id === 'backlog')
    if (!backlog) throw new Error('backlog')
    const labels = (f: typeof backlog, managesSchema: boolean, opensSettings: boolean) =>
      sidebarActions(d, f, { managesSchema, opensSettings }).map((a) => a.label)
    expect(labels(d.hub, true, true)).toEqual(['Attributes', 'New folder inside', 'Hub settings'])
    // An owner or admin who is not a hub admin: the root offers only the settings.
    expect(labels(d.hub, false, true)).toEqual(['Hub settings'])
    expect(labels(backlog, false, true)).toEqual([])
    // Subfolders never get it.
    expect(labels(backlog, true, true)).not.toContain('Hub settings')
    expect(labels(d.hub, false, false)).toEqual([])
  })

  it('lists where an attribute is shown, in tree order', () => {
    expect(usedIn(description(), 'title')).toEqual(['Build', 'Backlog'])
    expect(usedIn(description(), 'points')).toEqual([])
  })

  it('gives a new folder a colour no folder uses yet', () => {
    expect(nextFolderColor(description(), PALETTE_COLORS)).toBe('indigo')
  })
})

describe('buildCreateAttribute', () => {
  const draft = (type: AttributeTypeName, patch: Partial<AttributeDraft> = {}): AttributeDraft => ({
    ...emptyDraft(HUB),
    name: '  Field  ',
    type,
    ...patch,
  })
  const withOptions = {
    options: [
      { id: 'a', label: ' One ', color: 'red' as const },
      { id: 'b', label: 'Two' },
    ],
  }

  it('builds a valid attribute for every M1 type', () => {
    for (const type of ATTRIBUTE_TYPE_ORDER) {
      const built = buildCreateAttribute(
        draft(type, type === 'select' || type === 'multi_select' ? withOptions : {}),
        HUB,
      )
      expect(built.ok, type).toBe(true)
      if (!built.ok) continue
      expect(built.body.name).toBe('Field')
      // What the server stores must pass the stored shape too.
      const stored = attributeSchema.safeParse({
        ...built.body,
        workspaceId: WS,
        hubId: HUB,
        id: 'x',
        version: 0,
      })
      expect(stored.success, type).toBe(true)
    }
  })

  it('sends each type its config', () => {
    const body = (d: AttributeDraft) => {
      const built = buildCreateAttribute(d, HUB)
      return built.ok ? built.body : null
    }
    expect(body(draft('number', { numberFormat: 'currency', currency: 'eur' }))?.config).toEqual({
      format: 'currency',
      currency: 'EUR',
    })
    expect(body(draft('date', { includeTime: true }))?.config).toEqual({ includeTime: true })
    expect(body(draft('actor', { multiple: true }))?.config).toEqual({ multiple: true })
    expect(body(draft('auto_id', { prefix: 'bld' }))?.config).toEqual({ prefix: 'BLD' })
    expect(body(draft('auto_id'))?.config).toEqual({})
    expect(body(draft('select', withOptions))?.config).toEqual({
      options: [
        { id: 'a', label: 'One', color: 'red' },
        { id: 'b', label: 'Two' },
      ],
    })
    // A relation into this hub stays inside it; into another needs crossHub (D11).
    expect(body(draft('relation', { multiple: true }))?.config).toEqual({
      targetHubId: HUB,
      crossHub: false,
      multiple: true,
    })
    expect(body(draft('relation', { targetHubId: 'ops' }))?.config).toEqual({
      targetHubId: 'ops',
      crossHub: true,
      multiple: false,
    })
    expect(body(draft('text', { indexed: true }))?.indexed).toBe(true)
  })

  it('says what to fix', () => {
    const errors = (d: AttributeDraft) => {
      const built = buildCreateAttribute(d, HUB)
      return built.ok ? {} : built.errors
    }
    expect(errors({ ...emptyDraft(HUB) })).toEqual({
      name: 'Name the attribute.',
      type: 'Choose a type.',
    })
    expect(errors(draft('number', { numberFormat: 'currency', currency: 'EU' })).currency).toMatch(
      /three-letter/,
    )
    expect(errors(draft('auto_id', { prefix: '1X' })).prefix).toMatch(/letter/)
    expect(
      errors(
        draft('select', {
          options: [
            { id: 'a', label: 'X' },
            { id: 'b', label: 'x ' },
          ],
        }),
      ).options,
    ).toMatch(/Fix the options/)
    expect(errors(draft('relation', { targetHubId: '' })).targetHubId).toBe('Choose a hub.')
  })
})

describe('counts in words (D51)', () => {
  it('names the count of items that lose a value', () => {
    expect(strippedValuesMessage('options', 'Stage', 1)).toBe(
      '1 item holds an option you removed from Stage. Saving clears that value on it, with a revision each.',
    )
    expect(strippedValuesMessage('attribute', 'Points', 1280)).toMatch(
      /^1,280 items hold a value for Points\. Deleting it clears those values/,
    )
  })

  it('names the items that leave a required attribute empty', () => {
    expect(requiredEmptyText('Points', 'Backlog', 12)).toBe(
      'Points: 12 items in Backlog leave it empty.',
    )
    expect(requiredEmptyText('Points', 'Backlog', 1)).toBe(
      'Points: 1 item in Backlog leaves it empty.',
    )
  })
})
