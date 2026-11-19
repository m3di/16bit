import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  applyAttributeUpdate,
  type Attribute,
  attributeConflictErrorSchema,
  attributeSchema,
  confirmRequiredErrorSchema,
  createAttributeSchema,
  createFolderSchema,
  deleteAttributeQuerySchema,
  deleteFolderQuerySchema,
  folderAttributesConflictErrorSchema,
  folderAttributesResultSchema,
  folderAttributesSchema,
  folderConflictErrorSchema,
  hubConflictErrorSchema,
  hubDescriptionSchema,
  hubGrantEntrySchema,
  hubGrantPageSchema,
  hubSchema,
  invitePageSchema,
  MAX_FOLDER_ATTRIBUTES,
  setFolderAttributesSchema,
  updateAttributeSchema,
  updateFolderSchema,
  updateHubSchema,
} from './index.ts'

const folder = {
  workspaceId: 'w1',
  id: 'f1',
  hubId: 'h1',
  parentId: 'h1',
  name: 'Backlog',
  color: 'blue',
  idPrefix: 'BLD',
  itemCount: 3,
  version: 4,
} as const
const hub = { ...folder, id: 'h1', parentId: null, name: 'Build', titleAttributeId: 'title' }

const stage: Attribute = {
  workspaceId: 'w1',
  id: 'stage',
  hubId: 'h1',
  name: 'Stage',
  indexed: true,
  version: 0,
  type: 'select',
  config: {
    options: [
      { id: 'todo', label: 'To do' },
      { id: 'doing', label: 'Doing', color: 'amber' },
      { id: 'done', label: 'Done' },
    ],
  },
}

describe('hub', () => {
  it('carries a nullable title attribute and no parent (D50)', () => {
    expect(hubSchema.parse(hub).titleAttributeId).toBe('title')
    expect(hubSchema.parse({ ...hub, titleAttributeId: null }).titleAttributeId).toBeNull()
    expect(hubSchema.safeParse({ ...hub, parentId: 'x' }).success).toBe(false)
    expect(hubSchema.safeParse({ ...hub, titleAttributeId: undefined }).success).toBe(false)
  })

  it('is the hub of a hub description', () => {
    const description = {
      hub,
      hubRole: 'viewer',
      folders: [],
      attributes: [stage],
      folderAttributes: [],
      truncated: { folders: false, attributes: false, folderAttributes: false },
    }
    expect(hubDescriptionSchema.parse(description).hub.titleAttributeId).toBe('title')
    const untitled: Partial<typeof hub> = { ...hub }
    delete untitled.titleAttributeId
    expect(hubDescriptionSchema.safeParse({ ...description, hub: untitled }).success).toBe(false)
  })

  it('gives attributes a version, which a conflict carries', () => {
    expect(attributeSchema.parse(stage).version).toBe(0)
    const unversioned: Partial<Attribute> = { ...stage }
    delete unversioned.version
    expect(attributeSchema.safeParse(unversioned).success).toBe(false)
    expect(attributeSchema.safeParse({ ...stage, version: -1 }).success).toBe(false)
    const conflict = { error: 'conflict', message: 'm', current: { ...stage, version: 3 } }
    expect(attributeConflictErrorSchema.parse(conflict).current.version).toBe(3)
  })

  it('updates name, colour and title attribute with the version', () => {
    expect(updateHubSchema.parse({ version: 4, name: '  Build  ' })).toEqual({
      version: 4,
      name: 'Build',
    })
    expect(updateHubSchema.parse({ version: 0, titleAttributeId: null }).titleAttributeId).toBe(
      null,
    )
    expect(updateHubSchema.safeParse({ version: 4, color: 'red' }).success).toBe(true)
  })

  it('refuses an update without a version, without a change, or with other fields', () => {
    expect(updateHubSchema.safeParse({ name: 'Build' }).success).toBe(false)
    expect(updateHubSchema.safeParse({ version: 4 }).success).toBe(false)
    expect(updateHubSchema.safeParse({ version: 4, name: '   ' }).success).toBe(false)
    expect(updateHubSchema.safeParse({ version: 4, color: 'hotpink' }).success).toBe(false)
    expect(updateHubSchema.safeParse({ version: 4, idPrefix: 'NEW' }).success).toBe(false)
    expect(updateHubSchema.safeParse({ version: 4, parentId: 'f1' }).success).toBe(false)
  })

  it('takes the version on delete from the query string', () => {
    expect(deleteFolderQuerySchema.parse({ version: '4' })).toEqual({ version: 4 })
    expect(deleteFolderQuerySchema.safeParse({}).success).toBe(false)
    expect(deleteFolderQuerySchema.safeParse({ version: '-1' }).success).toBe(false)
  })
})

describe('folders', () => {
  it('creates a folder under a parent with a name and colour', () => {
    expect(createFolderSchema.parse({ parentId: 'h1', name: ' Ideas ', color: 'green' })).toEqual({
      parentId: 'h1',
      name: 'Ideas',
      color: 'green',
    })
    expect(createFolderSchema.safeParse({ name: 'Ideas', color: 'green' }).success).toBe(false)
    // A folder takes its hub's prefix; it cannot set its own.
    expect(
      createFolderSchema.safeParse({ parentId: 'h1', name: 'I', color: 'green', idPrefix: 'X' })
        .success,
    ).toBe(false)
  })

  it('renames, recolours and moves with the version', () => {
    expect(updateFolderSchema.safeParse({ version: 4, name: 'Later' }).success).toBe(true)
    expect(updateFolderSchema.safeParse({ version: 4, parentId: 'f2' }).success).toBe(true)
    expect(updateFolderSchema.safeParse({ version: 4 }).success).toBe(false)
    expect(updateFolderSchema.safeParse({ name: 'Later' }).success).toBe(false)
    expect(updateFolderSchema.safeParse({ version: 4, parentId: null }).success).toBe(false)
    expect(updateFolderSchema.safeParse({ version: 4, hubId: 'h2' }).success).toBe(false)
  })
})

describe('attributes', () => {
  it('creates an attribute of each type with its config', () => {
    const select = createAttributeSchema.parse({
      name: 'Stage',
      type: 'select',
      config: { options: [{ id: 'a', label: 'A' }] },
    })
    expect(select).toMatchObject({ type: 'select', indexed: false })
    expect(createAttributeSchema.parse({ name: 'Due', type: 'date', config: {} })).toEqual({
      name: 'Due',
      type: 'date',
      indexed: false,
      config: { includeTime: false },
    })
    expect(
      createAttributeSchema.parse({
        id: 'refs',
        name: 'Refs',
        type: 'relation',
        config: { targetHubId: 'h2', crossHub: true },
      }).config,
    ).toEqual({ targetHubId: 'h2', crossHub: true, multiple: true })
  })

  it('refuses unknown types, bad configs, and the stored-only fields', () => {
    expect(createAttributeSchema.safeParse({ name: 'F', type: 'file', config: {} }).success).toBe(
      false,
    )
    expect(
      createAttributeSchema.safeParse({ name: 'N', type: 'number', config: { decimals: 99 } })
        .success,
    ).toBe(false)
    expect(
      createAttributeSchema.safeParse({ name: 'T', type: 'text', config: {}, hubId: 'h1' }).success,
    ).toBe(false)
    expect(
      createAttributeSchema.safeParse({ name: 'T', type: 'text', config: {}, version: 1 }).success,
    ).toBe(false)
  })

  it('leaves the same-hub relation rule to attributeSchema once the hub is known (D11)', () => {
    const body = createAttributeSchema.parse({
      name: 'Refs',
      type: 'relation',
      config: { targetHubId: 'h2' },
    })
    const stored = { ...body, id: 'refs', workspaceId: 'w1', hubId: 'h1', version: 0 }
    expect(attributeSchema.safeParse(stored).success).toBe(false)
    expect(attributeSchema.safeParse({ ...stored, hubId: 'h2' }).success).toBe(true)
  })

  it('updates only the name and options, never the type or config (D51)', () => {
    expect(updateAttributeSchema.safeParse({ version: 1, name: 'Status' }).success).toBe(true)
    expect(
      updateAttributeSchema.safeParse({ version: 1, options: [{ id: 'a', label: 'A' }] }).success,
    ).toBe(true)
    // A type change is refused, alone or with a rename.
    expect(updateAttributeSchema.safeParse({ version: 1, type: 'text' }).success).toBe(false)
    expect(
      updateAttributeSchema.safeParse({ version: 1, name: 'Status', type: 'multi_select' }).success,
    ).toBe(false)
    // So are a relation's target and cross-hub flag, and any other config.
    expect(
      updateAttributeSchema.safeParse({ version: 1, config: { targetHubId: 'h2', crossHub: true } })
        .success,
    ).toBe(false)
    expect(updateAttributeSchema.safeParse({ version: 1, indexed: true }).success).toBe(false)
    expect(updateAttributeSchema.safeParse({ version: 1 }).success).toBe(false)
    // Attributes start at version 0, like folders.
    expect(updateAttributeSchema.safeParse({ version: 0, name: 'S' }).success).toBe(true)
    expect(updateAttributeSchema.safeParse({ version: -1, name: 'S' }).success).toBe(false)
    expect(updateAttributeSchema.safeParse({ name: 'S' }).success).toBe(false)
  })

  it('refuses duplicate option IDs in an update', () => {
    const options = [
      { id: 'a', label: 'A' },
      { id: 'a', label: 'B' },
    ]
    expect(updateAttributeSchema.safeParse({ version: 1, options }).success).toBe(false)
  })

  it('takes a non-negative confirm count', () => {
    expect(updateAttributeSchema.parse({ version: 1, options: [], confirm: 3 }).confirm).toBe(3)
    expect(updateAttributeSchema.safeParse({ version: 1, options: [], confirm: -1 }).success).toBe(
      false,
    )
    expect(updateAttributeSchema.safeParse({ version: 1, options: [], confirm: 1.5 }).success).toBe(
      false,
    )
    expect(deleteAttributeQuerySchema.parse({ version: '2', confirm: '7' })).toEqual({
      version: 2,
      confirm: 7,
    })
    expect(deleteAttributeQuerySchema.parse({ version: '2' })).toEqual({ version: 2 })
    expect(deleteAttributeQuerySchema.parse({ version: '0' })).toEqual({ version: 0 })
    expect(deleteAttributeQuerySchema.safeParse({ version: '-1' }).success).toBe(false)
    expect(deleteAttributeQuerySchema.safeParse({ version: '2', confirm: 'yes' }).success).toBe(
      false,
    )
    expect(deleteAttributeQuerySchema.safeParse({ confirm: '1' }).success).toBe(false)
  })

  describe('applyAttributeUpdate', () => {
    it('renames without touching options', () => {
      const result = applyAttributeUpdate(stage, { version: 1, name: 'Status' })
      expect(result).toEqual({
        ok: true,
        attribute: { ...stage, name: 'Status' },
        removedOptionIds: [],
      })
    })

    it('relabels, reorders and adds options without removing any', () => {
      const options = [
        { id: 'done', label: 'Shipped' },
        { id: 'todo', label: 'To do' },
        { id: 'doing', label: 'Doing' },
        { id: 'blocked', label: 'Blocked', color: 'red' as const },
      ]
      const result = applyAttributeUpdate(stage, { version: 1, options })
      expect(result.ok && result.removedOptionIds).toEqual([])
      expect(result.ok && result.attribute.config).toEqual({ options })
    })

    it('lists the options a change removes', () => {
      const result = applyAttributeUpdate(stage, {
        version: 1,
        options: [{ id: 'doing', label: 'Doing' }],
      })
      expect(result.ok && result.removedOptionIds).toEqual(['todo', 'done'])
    })

    it('works on multi-select too', () => {
      const tags: Attribute = { ...stage, id: 'tags', type: 'multi_select' }
      const result = applyAttributeUpdate(tags, { version: 1, options: [] })
      expect(result.ok && result.removedOptionIds).toEqual(['todo', 'doing', 'done'])
    })

    it('refuses options on a type without them', () => {
      const due: Attribute = { ...stage, id: 'due', type: 'date', config: { includeTime: false } }
      expect(applyAttributeUpdate(due, { version: 1, options: [] })).toEqual({
        ok: false,
        message: 'A date attribute has no options',
      })
    })
  })
})

describe('folder attributes', () => {
  it('sets the whole ordered list with required flags', () => {
    expect(
      setFolderAttributesSchema.parse({
        version: 4,
        attributes: [{ attributeId: 'title', required: true }, { attributeId: 'stage' }],
      }),
    ).toEqual({
      version: 4,
      dryRun: false,
      attributes: [
        { attributeId: 'title', required: true },
        { attributeId: 'stage', required: false },
      ],
    })
    expect(setFolderAttributesSchema.safeParse({ version: 4, attributes: [] }).success).toBe(true)
    expect(
      setFolderAttributesSchema.parse({ version: 4, dryRun: true, attributes: [] }).dryRun,
    ).toBe(true)
  })

  it('answers with how many items leave each required attribute empty (D51)', () => {
    const result = {
      folder,
      attributes: [
        {
          workspaceId: 'w1',
          hubId: 'h1',
          folderId: 'f1',
          attributeId: 'title',
          position: 0,
          required: true,
        },
      ],
      requiredEmpty: [{ attributeId: 'title', items: 2 }],
    }
    expect(folderAttributesResultSchema.parse(result)).toEqual(result)
    expect(
      folderAttributesResultSchema.safeParse({
        ...result,
        requiredEmpty: [{ attributeId: 'title', items: -1 }],
      }).success,
    ).toBe(false)
    expect(folderAttributesResultSchema.safeParse({ folder, attributes: [] }).success).toBe(false)
  })

  it('refuses duplicates, a missing version, positions and too many', () => {
    const dup = [{ attributeId: 'a' }, { attributeId: 'a' }]
    expect(setFolderAttributesSchema.safeParse({ version: 4, attributes: dup }).success).toBe(false)
    expect(setFolderAttributesSchema.safeParse({ attributes: [] }).success).toBe(false)
    expect(
      setFolderAttributesSchema.safeParse({
        version: 4,
        attributes: [{ attributeId: 'a', position: 3 }],
      }).success,
    ).toBe(false)
    const many = Array.from({ length: MAX_FOLDER_ATTRIBUTES + 1 }, (_, i) => ({
      attributeId: `a${String(i)}`,
    }))
    expect(setFolderAttributesSchema.safeParse({ version: 4, attributes: many }).success).toBe(
      false,
    )
  })

  it('returns the folder with its attributes', () => {
    const body = {
      folder: { ...folder, version: 5 },
      attributes: [
        {
          workspaceId: 'w1',
          hubId: 'h1',
          folderId: 'f1',
          attributeId: 'stage',
          position: 0,
          required: true,
        },
      ],
    }
    expect(folderAttributesSchema.parse(body).folder.version).toBe(5)
  })
})

describe('grants and invites', () => {
  it('pages grants by name and role only', () => {
    const page = {
      items: [
        {
          principalId: 'p1',
          kind: 'user',
          name: 'Mina',
          workspaceRole: 'member',
          hubRole: 'editor',
        },
        {
          principalId: 'k1',
          kind: 'agent',
          name: 'Triage bot',
          workspaceRole: 'member',
          hubRole: 'viewer',
          keyState: 'revoked',
        },
      ],
      nextCursor: null,
    }
    expect(hubGrantPageSchema.parse(page).items).toHaveLength(2)
    const withEmail = { ...page.items[0], email: 'mina@example.com' }
    expect(hubGrantPageSchema.safeParse({ ...page, items: [withEmail] }).success).toBe(false)
  })

  it('marks an agent grant with its key state, and only agent grants', () => {
    const [user, agent] = [
      { principalId: 'p1', kind: 'user', name: 'Mina', workspaceRole: 'member', hubRole: 'editor' },
      { principalId: 'k1', kind: 'agent', name: 'Bot', workspaceRole: 'member', hubRole: 'viewer' },
    ]
    for (const keyState of ['active', 'revoked', 'expired']) {
      expect(hubGrantEntrySchema.parse({ ...agent, keyState })).toMatchObject({ keyState })
    }
    expect(hubGrantEntrySchema.safeParse(agent).success).toBe(false)
    expect(hubGrantEntrySchema.safeParse({ ...agent, keyState: 'lost' }).success).toBe(false)
    expect(hubGrantEntrySchema.safeParse({ ...user, keyState: 'active' }).success).toBe(false)
  })

  it('pages pending invites', () => {
    const invite = {
      workspaceId: 'w1',
      id: 'inv1',
      workspaceRole: 'member',
      createdBy: 'p1',
      createdAt: '2026-11-18T10:00:00.000Z',
      expiresAt: '2026-11-25T10:00:00.000Z',
    }
    expect(invitePageSchema.parse({ items: [invite], nextCursor: 'c' }).nextCursor).toBe('c')
    expect(
      invitePageSchema.safeParse({ items: [{ ...invite, token: 'x' }], nextCursor: null }).success,
    ).toBe(false)
  })
})

describe('errors', () => {
  it('has codes for not empty, in use and confirmation (D51, D52)', () => {
    for (const code of ['not_empty', 'in_use', 'confirm_required'] as const) {
      expect(API_ERROR_CODES).toContain(code)
    }
    expect(apiErrorSchema.parse({ error: 'not_empty', message: 'm' }).error).toBe('not_empty')
  })

  it('answers a missing or stale confirm with the current count', () => {
    const body = { error: 'confirm_required', message: 'm', affected: 12 }
    expect(confirmRequiredErrorSchema.parse(body).affected).toBe(12)
    expect(apiErrorSchema.safeParse(body).success).toBe(true)
    expect(confirmRequiredErrorSchema.safeParse({ ...body, affected: 0 }).success).toBe(false)
    expect(
      confirmRequiredErrorSchema.safeParse({ error: 'confirm_required', message: 'm' }).success,
    ).toBe(false)
  })

  it('answers a stale version with the current hub, folder, folder attributes or attribute', () => {
    const conflict = (current: unknown) => ({ error: 'conflict', message: 'stale', current })
    expect(hubConflictErrorSchema.safeParse(conflict(hub)).success).toBe(true)
    expect(hubConflictErrorSchema.safeParse(conflict(folder)).success).toBe(false)
    expect(folderConflictErrorSchema.safeParse(conflict(folder)).success).toBe(true)
    expect(
      folderAttributesConflictErrorSchema.safeParse(conflict({ folder, attributes: [] })).success,
    ).toBe(true)
    expect(attributeConflictErrorSchema.safeParse(conflict(stage)).success).toBe(true)
    expect(attributeConflictErrorSchema.safeParse(conflict(folder)).success).toBe(false)
  })
})
