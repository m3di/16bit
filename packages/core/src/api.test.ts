import { describe, expect, it } from 'vitest'
import {
  conflictErrorSchema,
  createItemSchema,
  deleteItemQuerySchema,
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
})
