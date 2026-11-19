import { describe, expect, it } from 'vitest'
import {
  backlinkPageSchema,
  MAX_HIDDEN_BACKLINKS,
  conflictErrorSchema,
  createHubSchema,
  createItemSchema,
  hubListEntrySchema,
  setHubGrantSchema,
  deleteItemQuerySchema,
  getItemQuerySchema,
  hubDescriptionSchema,
  itemReadSchema,
  itemQueryResultSchema,
  itemQuerySchema,
  pageQuerySchema,
  patchItemSchema,
} from './index.ts'

const item = {
  workspaceId: 'w1',
  id: 'i1',
  hubId: 'h1',
  folderId: 'h1',
  seqId: 1,
  values: { title: 'x' },
  version: 2,
  updatedAt: '2026-11-16T10:00:00.000Z',
  updatedBy: 'p1',
}

describe('api contracts', () => {
  it('requires the expected version and at least one value on a patch', () => {
    expect(patchItemSchema.safeParse({ version: 1, values: { title: 'y' } }).success).toBe(true)
    expect(patchItemSchema.safeParse({ values: { title: 'y' } }).success).toBe(false)
    expect(patchItemSchema.safeParse({ version: 0, values: { title: 'y' } }).success).toBe(false)
    expect(patchItemSchema.safeParse({ version: 1, values: {} }).success).toBe(false)
  })

  it('describes a conflict as the current item', () => {
    const body = { error: 'conflict', message: 'stale', current: item }
    expect(conflictErrorSchema.parse(body).current.version).toBe(2)
    expect(conflictErrorSchema.safeParse({ ...body, current: undefined }).success).toBe(false)
  })

  it('defaults and bounds paging', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(pageQuerySchema.parse({ limit: '10' }).limit).toBe(10)
    expect(pageQuerySchema.safeParse({ limit: '201' }).success).toBe(false)
    expect(itemQuerySchema.parse({ from: 'f1', limit: 50 })).toEqual({
      from: 'f1',
      where: null,
      sort: [],
      expand: [],
      limit: 50,
      cursor: null,
    })
    expect(itemQuerySchema.safeParse({ from: 'f1' }).success).toBe(false)
    expect(itemQuerySchema.safeParse({ from: 'f1', where: {} }).success).toBe(false)
  })

  it('checks create and delete input', () => {
    expect(createItemSchema.parse({ folderId: 'f1' })).toEqual({ folderId: 'f1', values: {} })
    expect(createItemSchema.safeParse({ folderId: 'f1', id: 'bad id' }).success).toBe(false)
    expect(deleteItemQuerySchema.parse({ version: '3' })).toEqual({ version: 3 })
    expect(deleteItemQuerySchema.safeParse({}).success).toBe(false)
  })

  it('separates granted hubs from name-only ones in the hub list', () => {
    const folder = {
      workspaceId: 'w1',
      id: 'h1',
      hubId: 'h1',
      parentId: null,
      name: 'Hub',
      color: 'blue',
      idPrefix: 'H',
      itemCount: 3,
      version: 0,
    }
    const granted = { ...folder, access: 'granted', hubRole: 'editor' }
    expect(hubListEntrySchema.safeParse(granted).success).toBe(true)
    expect(hubListEntrySchema.safeParse({ ...granted, hubRole: undefined }).success).toBe(false)
    const none = { access: 'none', workspaceId: 'w1', id: 'h1', name: 'Hub', color: 'blue' }
    expect(hubListEntrySchema.safeParse(none).success).toBe(true)
    expect(hubListEntrySchema.safeParse({ ...none, itemCount: 3 }).success).toBe(false)
    expect(hubListEntrySchema.safeParse({ ...none, hubRole: 'viewer' }).success).toBe(false)
  })

  it('checks a new hub and a grant', () => {
    expect(createHubSchema.parse({ name: ' Ops ', color: 'teal', idPrefix: 'OPS' })).toEqual({
      name: 'Ops',
      color: 'teal',
      idPrefix: 'OPS',
    })
    expect(createHubSchema.safeParse({ name: 'x', color: 'teal', idPrefix: 'ops' }).success).toBe(
      false,
    )
    expect(setHubGrantSchema.safeParse({ hubRole: 'hub_admin' }).success).toBe(true)
    expect(setHubGrantSchema.safeParse({ hubRole: 'owner' }).success).toBe(false)
  })

  it('bounds expand and keeps linked items without values when they cannot be read', () => {
    const query = (expand: unknown) => itemQuerySchema.safeParse({ from: 'f1', limit: 5, expand })
    expect(query(['r1', 'r2', 'r3']).success).toBe(true)
    expect(query(['r1', 'r2', 'r3', 'r4']).success).toBe(false)
    expect(query(['r1', 'r1']).success).toBe(false)

    const page = { items: [item], nextCursor: null }
    expect(itemQueryResultSchema.parse(page)).toEqual(page)
    const linked = { i2: { access: 'read', item }, i3: { access: 'none' } }
    const expanded = itemQueryResultSchema.parse({ ...page, linked, linkedTruncated: false })
    expect(expanded.linked).toEqual(linked)
    expect(expanded.linkedTruncated).toBe(false)
    // A hidden item never carries its values.
    expect(
      itemQueryResultSchema.safeParse({ ...page, linked: { i3: { access: 'none', item } } })
        .success,
    ).toBe(false)
  })

  it('lists readable backlinks only and counts the hidden ones', () => {
    const body = { items: [{ attributeId: 'rel', item }], nextCursor: null, hidden: 2 }
    expect(backlinkPageSchema.parse(body)).toEqual(body)
    // A hidden linking item is never named.
    expect(
      backlinkPageSchema.safeParse({
        ...body,
        items: [{ access: 'none', itemId: 'i9', attributeId: 'rel' }],
      }).success,
    ).toBe(false)
    expect(backlinkPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false)
    expect(
      backlinkPageSchema.safeParse({
        items: [],
        nextCursor: null,
        hidden: MAX_HIDDEN_BACKLINKS + 1,
      }).success,
    ).toBe(false)
  })

  it('reads expand on a single item from a comma list, repeated keys, or both', () => {
    const expand = (q: unknown) => getItemQuerySchema.safeParse(q)
    expect(expand({}).data).toEqual({ expand: [] })
    expect(expand({ expand: '' }).data).toEqual({ expand: [] })
    expect(expand({ expand: 'r1' }).data).toEqual({ expand: ['r1'] })
    expect(expand({ expand: 'r1,r2' }).data).toEqual({ expand: ['r1', 'r2'] })
    expect(expand({ expand: ['r1,r2', 'r3'] }).data).toEqual({ expand: ['r1', 'r2', 'r3'] })
    expect(expand({ expand: 'r1,r2,r3,r4' }).success).toBe(false)
    expect(expand({ expand: ['r1', 'r1'] }).success).toBe(false)
    expect(expand({ expand: 'r1,,r2' }).success).toBe(false)
    expect(expand({ expand: 'r 1' }).success).toBe(false)
    expect(expand({ other: 'x' }).success).toBe(false)

    expect(itemReadSchema.parse(item)).toEqual(item)
    const linked = { i2: { access: 'read', item }, i3: { access: 'none' } }
    expect(itemReadSchema.parse({ ...item, linked, linkedTruncated: false }).linked).toEqual(linked)
    expect(
      itemReadSchema.safeParse({ ...item, linked: { i3: { access: 'none', item } } }).success,
    ).toBe(false)
  })

  it("carries the caller's hub role in a hub description", () => {
    const hub = {
      workspaceId: 'w1',
      id: 'h1',
      hubId: 'h1',
      parentId: null,
      name: 'Hub',
      color: 'blue',
      idPrefix: 'HUB',
      itemCount: 0,
      version: 1,
      titleAttributeId: null,
    }
    const body = {
      hub,
      folders: [],
      attributes: [],
      folderAttributes: [],
      truncated: { folders: false, attributes: false, folderAttributes: false },
    }
    expect(hubDescriptionSchema.safeParse(body).success).toBe(false)
    expect(hubDescriptionSchema.parse({ ...body, hubRole: 'viewer' }).hubRole).toBe('viewer')
  })
})
