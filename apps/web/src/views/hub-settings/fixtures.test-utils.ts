import type { Attribute, Folder, HubDescription, HubRole, Me, WorkspaceRole } from '@16bit/core'

// Shared test data for hub settings. Only imported by tests.

export const WS = 'w1'
export const HUB = 'bld'

const folderOf = (
  id: string,
  parentId: string | null,
  name: string,
  itemCount: number,
): Folder => ({
  workspaceId: WS,
  id,
  hubId: HUB,
  parentId,
  name,
  color: 'teal',
  idPrefix: 'BLD',
  itemCount,
  version: 2,
})

export const attributeList = (): Attribute[] => [
  {
    workspaceId: WS,
    id: 'title',
    hubId: HUB,
    name: 'Title',
    indexed: true,
    version: 0,
    type: 'text',
    config: {},
  },
  {
    workspaceId: WS,
    id: 'stage',
    hubId: HUB,
    name: 'Stage',
    indexed: true,
    version: 3,
    type: 'select',
    config: {
      options: [
        { id: 'todo', label: 'To do', color: 'grey' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  },
  {
    workspaceId: WS,
    id: 'points',
    hubId: HUB,
    name: 'Points',
    indexed: false,
    version: 1,
    type: 'number',
    config: { format: 'plain' },
  },
]

/**
 * Build hub: Backlog (3 items), Sprints (empty, holds Sprint 1), Sprint 1 (empty). Backlog
 * shows Title (required) and Stage; the hub itself shows Title.
 */
export function description(hubRole: HubRole = 'hub_admin'): HubDescription {
  return {
    hub: { ...folderOf(HUB, null, 'Build', 5), parentId: null, titleAttributeId: 'title' },
    hubRole,
    folders: [
      folderOf('backlog', HUB, 'Backlog', 3),
      folderOf('sprints', HUB, 'Sprints', 0),
      folderOf('sprint-1', 'sprints', 'Sprint 1', 0),
    ],
    attributes: attributeList(),
    folderAttributes: [
      {
        workspaceId: WS,
        hubId: HUB,
        folderId: HUB,
        attributeId: 'title',
        position: 0,
        required: false,
      },
      {
        workspaceId: WS,
        hubId: HUB,
        folderId: 'backlog',
        attributeId: 'title',
        position: 0,
        required: true,
      },
      {
        workspaceId: WS,
        hubId: HUB,
        folderId: 'backlog',
        attributeId: 'stage',
        position: 1,
        required: false,
      },
    ],
    truncated: { folders: false, attributes: false, folderAttributes: false },
  }
}

export const meAs = (role: WorkspaceRole): Me => ({
  kind: 'person',
  account: { id: 'acc-sara', email: 'sara@example.com', name: 'Sara' },
  memberships: [
    { workspace: { id: WS, name: 'Parcel Tracker' }, principalId: 'p-sara', workspaceRole: role },
  ],
  truncated: false,
})
