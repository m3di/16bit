import { describe, expect, it } from 'vitest'
import {
  backlinkPageSchema,
  conflictErrorSchema,
  createItemSchema,
  deleteItemQuerySchema,
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

  it('bounds expand and keeps linked items without values when they cannot be read', () => {
    const query = (expand: unknown) => itemQuerySchema.safeParse({ from: 'f1', limit: 5, expand })
    expect(query(['r1', 'r2', 'r3']).success).toBe(true)
    expect(query(['r1', 'r2', 'r3', 'r4']).success).toBe(false)
    expect(query(['r1', 'r1']).success).toBe(false)

    const page = { items: [item], nextCursor: null }
    expect(itemQueryResultSchema.parse(page)).toEqual(page)
    const linked = { i2: { access: 'read', item }, i3: { access: 'none' } }
    expect(itemQueryResultSchema.parse({ ...page, linked }).linked).toEqual(linked)
    // A hidden item never carries its values.
    expect(
      itemQueryResultSchema.safeParse({ ...page, linked: { i3: { access: 'none', item } } })
        .success,
    ).toBe(false)
  })

  it('describes backlinks with and without access', () => {
    const body = {
      items: [
        { access: 'read', itemId: 'i1', attributeId: 'rel', item },
        { access: 'none', itemId: 'i9', attributeId: 'rel' },
      ],
      nextCursor: null,
    }
    expect(backlinkPageSchema.parse(body)).toEqual(body)
    expect(
      backlinkPageSchema.safeParse({
        items: [{ access: 'none', itemId: 'i9', attributeId: 'rel', item }],
        nextCursor: null,
      }).success,
    ).toBe(false)
  })
})
