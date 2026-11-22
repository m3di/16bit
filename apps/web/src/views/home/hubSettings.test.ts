import type { HubListEntry, HubRole, Subject, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { hubSettingsRoute } from './hubSettings.ts'

const granted = (hubRole: HubRole): HubListEntry => ({
  access: 'granted',
  hubRole,
  workspaceId: 'w',
  id: 'eng',
  hubId: 'eng',
  parentId: null,
  name: 'Engineering',
  color: 'teal',
  idPrefix: 'ENG',
  itemCount: 3,
  version: 1,
})

const none: HubListEntry = {
  access: 'none',
  workspaceId: 'w',
  id: 'fin',
  name: 'Finance',
  color: 'amber',
}

const as = (workspaceRole: WorkspaceRole): Subject => ({ id: 'p', kind: 'user', workspaceRole })
const general = { name: 'hub-settings-general', params: { workspaceId: 'w', hubId: 'eng' } }

describe('hubSettingsRoute (docs/ROLES.md)', () => {
  it('leads hub admins, owners and admins to the hub’s General settings', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(hubSettingsRoute(as(role), granted('hub_admin')), role).toEqual(general)
    }
  })

  it('leads owners and admins there whatever their grant', () => {
    for (const grant of ['editor', 'commenter', 'viewer'] as const) {
      expect(hubSettingsRoute(as('owner'), granted(grant)), grant).toEqual(general)
      expect(hubSettingsRoute(as('admin'), granted(grant)), grant).toEqual(general)
    }
  })

  it('offers nothing to editors, commenters, viewers and finance', () => {
    for (const grant of ['editor', 'commenter', 'viewer'] as const) {
      expect(hubSettingsRoute(as('member'), granted(grant)), grant).toBeNull()
    }
    // Viewer and finance act as viewer at most, whatever the grant says.
    expect(hubSettingsRoute(as('viewer'), granted('hub_admin'))).toBeNull()
    expect(hubSettingsRoute(as('finance'), granted('hub_admin'))).toBeNull()
  })

  it('offers nothing on a hub without a grant, or without a known reader', () => {
    expect(hubSettingsRoute(as('owner'), none)).toBeNull()
    expect(hubSettingsRoute(null, granted('hub_admin'))).toBeNull()
  })
})
