import type { HubListEntry, HubRole, Subject, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { hubActionRoute, hubActions } from './hubActions.ts'

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
const keys = (viewer: Subject | null, hub: HubListEntry) =>
  hubActions(viewer, hub).map((a) => a.key)

const ALL = ['open', 'settings', 'folders', 'attributes', 'access', 'keys', 'delete']

describe('hubActions (can(), docs/ROLES.md)', () => {
  it('gives owners and admins holding hub admin every entry', () => {
    expect(keys(as('owner'), granted('hub_admin'))).toEqual(ALL)
    expect(keys(as('admin'), granted('hub_admin'))).toEqual(ALL)
  })

  it('gives a member who is hub admin the settings but not the delete', () => {
    expect(keys(as('member'), granted('hub_admin'))).toEqual(ALL.filter((k) => k !== 'delete'))
  })

  it('gives owners and admins with a lower grant what their workspace role allows', () => {
    expect(keys(as('admin'), granted('editor'))).toEqual(['open', 'access', 'keys', 'delete'])
  })

  it('gives editors, commenters and viewers only Open', () => {
    for (const role of ['editor', 'commenter', 'viewer'] as const) {
      expect(keys(as('member'), granted(role)), role).toEqual(['open'])
    }
    // Viewer and finance act as viewer at most, whatever the grant says.
    expect(keys(as('viewer'), granted('viewer'))).toEqual(['open'])
    expect(keys(as('finance'), granted('viewer'))).toEqual(['open'])
  })

  it('without a known reader, offers only Open', () => {
    expect(keys(null, granted('hub_admin'))).toEqual(['open'])
    expect(keys(null, none)).toEqual([])
  })

  it('marks the delete as destructive', () => {
    expect(hubActions(as('owner'), granted('hub_admin')).at(-1)).toMatchObject({
      key: 'delete',
      label: 'Delete hub…',
      danger: true,
    })
  })

  it('offers the self-grant on a hub without a grant, and nothing else', () => {
    expect(hubActions(as('admin'), none)).toEqual([
      { key: 'grant-self', label: 'Give myself access' },
    ])
  })

  it('keeps the self-grant visible but unusable while it runs, and drops it once given', () => {
    expect(hubActions(as('owner'), none, { state: 'busy' })).toEqual([
      {
        key: 'grant-self',
        label: 'Giving access',
        disabled: true,
        reason: 'Access is being given.',
      },
    ])
    expect(hubActions(as('owner'), none, { state: 'error', message: 'x' })[0]?.disabled).toBe(
      undefined,
    )
    expect(hubActions(as('owner'), none, { state: 'stale' })).toEqual([])
  })

  it('never offers the self-grant to agents', () => {
    expect(hubActions({ id: 'a', kind: 'agent', workspaceRole: 'member' }, none)).toEqual([])
  })
})

describe('hubActionRoute', () => {
  const hub = granted('hub_admin')
  const params = { workspaceId: 'w', hubId: 'eng' }

  it('opens the hub and each settings section', () => {
    expect(hubActionRoute('open', hub)).toEqual({ name: 'hub', params })
    expect(hubActionRoute('settings', hub)).toEqual({ name: 'hub-settings-general', params })
    expect(hubActionRoute('folders', hub)).toEqual({ name: 'hub-settings-folders', params })
    expect(hubActionRoute('attributes', hub)).toEqual({ name: 'hub-settings-attributes', params })
    expect(hubActionRoute('access', hub)).toEqual({ name: 'hub-settings-access', params })
    expect(hubActionRoute('keys', hub)).toEqual({ name: 'hub-settings-keys', params })
  })

  it('sends Delete hub to the Danger zone, and runs the self-grant here', () => {
    expect(hubActionRoute('delete', hub)).toEqual({ name: 'hub-settings-danger', params })
    expect(hubActionRoute('grant-self', none)).toBe(null)
  })
})
