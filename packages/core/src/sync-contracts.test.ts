import { describe, expect, it } from 'vitest'
import {
  changesPageSchema,
  changesQuerySchema,
  createItemSchema,
  decodeItemCursor,
  deleteItemQuerySchema,
  encodeItemCursor,
  feedServerMessageSchema,
  hubDescriptionSchema,
  itemQueryResultSchema,
  itemQuerySchema,
  itemReadSchema,
  itemWriteResultSchema,
  MAX_CHANGES_LIMIT,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_QUERY_OFFSET,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  parseFeedClientMessage,
  patchItemSchema,
  utf8ByteLength,
  type ItemCursor,
} from './index.ts'

// Contracts for M3 sync: the feed protocol and changes route (D57, D58), client mutation IDs
// (D59), and query windows and orders (D61).

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
const MUTATION = '0b3f5c8e-6a4d-4f6b-9c1e-2d7a8b9c0d1e'

const updatedCursor = encodeItemCursor({
  order: 'updated',
  after: ['2026-11-16T10:00:00.123456Z', 'i1'],
})
const numberCursor = encodeItemCursor({ order: 'number', after: [42] })
const sortCursor = encodeItemCursor({ order: 'sort', after: [3, null, 'i1'] })

describe('item query cursor', () => {
  it.each<ItemCursor>([
    { order: 'updated', after: ['2026-11-16T10:00:00.123456Z', 'i1'] },
    { order: 'number', after: [1] },
    { order: 'sort', after: ['Zoë 🚀 日本', 'i1'] },
    { order: 'sort', after: [null, -1.5, 'b', 'i1'] },
  ])('round-trips %j as base64url', (cursor) => {
    const text = encodeItemCursor(cursor)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeItemCursor(text)).toEqual(cursor)
  })

  it('refuses anything it did not make', () => {
    // A cursor from before #168: a bare tuple with no order (`["x","a"]`).
    expect(decodeItemCursor('WyJ4IiwiYSJd')).toBeNull()
    expect(decodeItemCursor('not base64!')).toBeNull()
    expect(decodeItemCursor('a')).toBeNull()
    expect(decodeItemCursor('')).toBeNull()
    // Valid base64url of JSON with an unknown order, or keys of the wrong shape.
    expect(decodeItemCursor('WyJ4IiwxXQ')).toBeNull() // ["x",1]
    expect(decodeItemCursor('WyJudW1iZXIiLDBd')).toBeNull() // ["number",0]
    expect(decodeItemCursor('WyJ1cGRhdGVkIiwiaTEiXQ')).toBeNull() // ["updated","i1"]
  })

  it('counts UTF-8 bytes', () => {
    expect(utf8ByteLength('a')).toBe(1)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('日')).toBe(3)
    expect(utf8ByteLength('🚀')).toBe(4)
  })
})

describe('item query windows and orders (D61)', () => {
  const parse = (body: object) => itemQuerySchema.safeParse({ from: 'f1', limit: 50, ...body })
  const message = (body: object) =>
    parse(body)
      .error?.issues.map((i) => i.message)
      .join('; ')

  it('takes order, offset and count', () => {
    expect(parse({}).data).toMatchObject({ count: false })
    expect(parse({}).data?.order).toBeUndefined()
    expect(parse({ order: 'number', offset: MAX_QUERY_OFFSET, count: true }).data).toMatchObject({
      order: 'number',
      offset: MAX_QUERY_OFFSET,
      count: true,
    })
    expect(parse({ order: 'updated', offset: 0 }).success).toBe(true)
    expect(parse({ order: 'title' }).success).toBe(false)
    expect(parse({ offset: -1 }).success).toBe(false)
    expect(parse({ offset: MAX_QUERY_OFFSET + 1 }).success).toBe(false)
    expect(parse({ offset: 1.5 }).success).toBe(false)
    expect(parse({ count: 'yes' }).success).toBe(false)
  })

  it('refuses offset with cursor', () => {
    expect(message({ offset: 0, cursor: updatedCursor })).toContain('not both')
    expect(message({ offset: 200, order: 'number', cursor: numberCursor })).toContain('not both')
  })

  it('refuses order with sort, either order', () => {
    const sort = [{ attribute: 'a1' }]
    expect(message({ order: 'number', sort })).toContain('order cannot be combined with sort')
    expect(message({ order: 'updated', sort })).toContain('order cannot be combined with sort')
    expect(parse({ order: 'number', sort: [] }).success).toBe(true)
  })

  it('accepts a cursor under its own order only', () => {
    expect(parse({ cursor: updatedCursor }).success).toBe(true)
    expect(parse({ order: 'updated', cursor: updatedCursor }).success).toBe(true)
    expect(parse({ order: 'number', cursor: numberCursor }).success).toBe(true)
    expect(parse({ sort: [{ attribute: 'a1' }], cursor: sortCursor }).success).toBe(true)

    expect(message({ order: 'number', cursor: updatedCursor })).toContain(
      'from the updated order and cannot page the number order',
    )
    expect(message({ cursor: numberCursor })).toContain(
      'from the number order and cannot page the updated order',
    )
    expect(message({ sort: [{ attribute: 'a1' }], cursor: numberCursor })).toContain(
      'cannot page the sort order',
    )
    expect(message({ order: 'number', cursor: sortCursor })).toContain('from the sort order')
    expect(message({ cursor: 'WyJ4IiwiYSJd' })).toContain('Invalid cursor')
  })

  it('adds total and seq to the result', () => {
    const page = { items: [item], nextCursor: null, seq: 7 }
    // Required since M3-03 (#170).
    expect(itemQueryResultSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(false)
    expect(itemQueryResultSchema.parse(page)).toEqual(page)
    expect(itemQueryResultSchema.parse({ ...page, total: 50_000 })).toMatchObject({
      total: 50_000,
      seq: 7,
    })
    expect(itemQueryResultSchema.safeParse({ ...page, total: -1 }).success).toBe(false)
    expect(itemQueryResultSchema.safeParse({ ...page, seq: 1.5 }).success).toBe(false)
  })
})

describe('seq on read and write responses (D58)', () => {
  it('carries seq on item reads and writes', () => {
    expect(itemReadSchema.parse({ ...item, seq: 0 }).seq).toBe(0)
    expect(itemWriteResultSchema.parse({ ...item, seq: 12 }).seq).toBe(12)
    expect(itemReadSchema.safeParse({ ...item, seq: -1 }).success).toBe(false)
    expect(itemWriteResultSchema.safeParse({ ...item, seq: '12' }).success).toBe(false)
    expect(itemReadSchema.safeParse(item).success).toBe(false)
    expect(itemWriteResultSchema.safeParse(item).success).toBe(false)
  })

  it('carries seq on a hub description', () => {
    const body = {
      hub: {
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
      },
      hubRole: 'viewer',
      folders: [],
      attributes: [],
      folderAttributes: [],
      truncated: { folders: false, attributes: false, folderAttributes: false },
    }
    expect(hubDescriptionSchema.parse({ ...body, seq: 3 }).seq).toBe(3)
    expect(hubDescriptionSchema.safeParse({ ...body, seq: null }).success).toBe(false)
    expect(hubDescriptionSchema.safeParse(body).success).toBe(false)
  })
})

describe('client mutation IDs (D59)', () => {
  it('takes an optional UUID on create, patch and delete', () => {
    expect(createItemSchema.parse({ folderId: 'f1', clientMutationId: MUTATION })).toEqual({
      folderId: 'f1',
      values: {},
      clientMutationId: MUTATION,
    })
    expect(
      patchItemSchema.parse({ version: 1, values: { t: 'y' }, clientMutationId: MUTATION })
        .clientMutationId,
    ).toBe(MUTATION)
    expect(deleteItemQuerySchema.parse({ version: '3', clientMutationId: MUTATION })).toEqual({
      version: 3,
      clientMutationId: MUTATION,
    })
    expect(createItemSchema.parse({ folderId: 'f1' })).not.toHaveProperty('clientMutationId')
  })

  it('refuses anything but a UUID', () => {
    for (const id of ['', 'retry-1', '0b3f5c8e6a4d4f6b9c1e2d7a8b9c0d1e', 42]) {
      expect(createItemSchema.safeParse({ folderId: 'f1', clientMutationId: id }).success).toBe(
        false,
      )
      expect(
        patchItemSchema.safeParse({ version: 1, values: { t: 'y' }, clientMutationId: id }).success,
      ).toBe(false)
      expect(deleteItemQuerySchema.safeParse({ version: '1', clientMutationId: id }).success).toBe(
        false,
      )
    }
  })
})

describe('feed client messages (D57)', () => {
  it('parses subscribe and unsubscribe', () => {
    expect(parseFeedClientMessage('{"type":"subscribe","hubId":"h1","after":0}')).toEqual({
      ok: true,
      message: { type: 'subscribe', hubId: 'h1', after: 0 },
    })
    expect(parseFeedClientMessage('{"type":"unsubscribe","hubId":"h1"}')).toEqual({
      ok: true,
      message: { type: 'unsubscribe', hubId: 'h1' },
    })
  })

  it.each([
    ['not JSON', 'subscribe h1'],
    ['an unknown type', '{"type":"query","hubId":"h1"}'],
    ['subscribe without after', '{"type":"subscribe","hubId":"h1"}'],
    ['a negative after', '{"type":"subscribe","hubId":"h1","after":-1}'],
    ['a bad hub ID', '{"type":"subscribe","hubId":"h 1","after":0}'],
    ['an extra key', '{"type":"unsubscribe","hubId":"h1","after":0}'],
    ['an array', '[]'],
  ])('refuses %s as invalid_message', (_, text) => {
    expect(parseFeedClientMessage(text)).toMatchObject({ ok: false, code: 'invalid_message' })
  })

  it('refuses an oversized message before parsing it', () => {
    const at = (bytes: number, pad: string) => {
      const base = '{"type":"unsubscribe","hubId":"h1"}'
      const padLength = (bytes - base.length) / utf8ByteLength(pad)
      return `${base.slice(0, -1)},"x":"${pad.repeat(padLength - 7)}"}`
    }
    // At the cap: refused by the schema (the extra key), not for its size.
    const exact = at(MAX_CLIENT_MESSAGE_BYTES, 'a')
    expect(utf8ByteLength(exact)).toBe(MAX_CLIENT_MESSAGE_BYTES)
    expect(parseFeedClientMessage(exact)).toMatchObject({ code: 'invalid_message' })
    expect(parseFeedClientMessage(`${exact} `)).toMatchObject({
      ok: false,
      code: 'message_too_large',
    })
    // Counted in UTF-8 bytes, not characters: under the cap in characters, over it in bytes.
    const wide = `{"type":"unsubscribe","hubId":"h1","x":"${'日'.repeat(1400)}"}`
    expect(wide.length).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES)
    expect(parseFeedClientMessage(wide)).toMatchObject({ code: 'message_too_large' })
    expect(parseFeedClientMessage('x'.repeat(1_000_000))).toMatchObject({
      code: 'message_too_large',
    })
  })
})

describe('feed server messages (D58)', () => {
  const change = { seq: 5, hubId: 'h1', itemId: 'i1', item }

  it('sends changes with a high-water seq for the hubs it names, even when all were hidden', () => {
    const parse = (m: object) => feedServerMessageSchema.safeParse(m)
    const base = { type: 'changes', seq: 9, hubIds: ['h1'] }
    expect(parse({ ...base, changes: [change] }).success).toBe(true)
    expect(parse({ ...base, changes: [] }).success).toBe(true)
    expect(parse({ ...base, hubIds: ['h1', 'h2'], changes: [] }).success).toBe(true)
    expect(parse({ type: 'changes', hubIds: ['h1'], changes: [change] }).success).toBe(false)
    // Which hubs the high-water mark covers is always said, and never as an empty list (#171).
    expect(parse({ type: 'changes', seq: 9, changes: [change] }).success).toBe(false)
    expect(parse({ ...base, hubIds: [], changes: [] }).success).toBe(false)
    const many = Array.from({ length: MAX_SUBSCRIPTIONS_PER_SOCKET + 1 }, (_, i) => `h${String(i)}`)
    expect(parse({ ...base, hubIds: many, changes: [] }).success).toBe(false)
    // A deletion is the item as null; the echo of a writer's mutation ID is optional.
    expect(
      parse({ ...base, changes: [{ ...change, item: null, clientMutationId: MUTATION }] }).success,
    ).toBe(true)
    expect(parse({ ...base, changes: [{ ...change, item: undefined }] }).success).toBe(false)
    // No patch is ever sent, only the item as it is now.
    expect(parse({ ...base, changes: [{ ...change, patch: { op: 'delete' } }] }).success).toBe(
      false,
    )
  })

  it('sends hub, access_lost, resync and error', () => {
    const ok = (m: object) => feedServerMessageSchema.parse(m)
    expect(ok({ type: 'hub', hubId: 'h1', version: 4 })).toEqual({
      type: 'hub',
      hubId: 'h1',
      version: 4,
    })
    expect(ok({ type: 'access_lost', hubId: 'h1' }).type).toBe('access_lost')
    expect(ok({ type: 'resync', hubId: 'h1' }).type).toBe('resync')
    expect(
      ok({ type: 'error', code: 'not_found', message: 'Hub not found', hubId: 'h9' }),
    ).toMatchObject({ code: 'not_found' })
    for (const code of ['invalid_message', 'message_too_large', 'too_many_subscriptions']) {
      expect(feedServerMessageSchema.safeParse({ type: 'error', code, message: 'x' }).success).toBe(
        true,
      )
    }
    expect(
      feedServerMessageSchema.safeParse({ type: 'error', code: 'forbidden', message: 'x' }).success,
    ).toBe(false)
    expect(feedServerMessageSchema.safeParse({ type: 'hub', hubId: 'h1' }).success).toBe(false)
  })
})

describe('GET /changes', () => {
  it('pages by after and limit, up to MAX_CHANGES_LIMIT', () => {
    expect(changesQuerySchema.parse({ after: '0' })).toEqual({ after: 0, limit: 200 })
    expect(changesQuerySchema.parse({ after: '17', limit: '1000' })).toEqual({
      after: 17,
      limit: MAX_CHANGES_LIMIT,
    })
    expect(changesQuerySchema.safeParse({}).success).toBe(false)
    expect(changesQuerySchema.safeParse({ after: '-1' }).success).toBe(false)
    expect(changesQuerySchema.safeParse({ after: 'x' }).success).toBe(false)
    expect(changesQuerySchema.safeParse({ after: '1.5' }).success).toBe(false)
    // An empty or loose `after` would otherwise coerce to a number and replay history.
    for (const after of ['', ' ', ' 1', '1e3', '0x10', '+1', 1]) {
      expect(changesQuerySchema.safeParse({ after }).success, JSON.stringify(after)).toBe(false)
    }
    expect(changesQuerySchema.safeParse({ after: '0', limit: '0' }).success).toBe(false)
    expect(changesQuerySchema.safeParse({ after: '0', limit: '1001' }).success).toBe(false)
    expect(changesQuerySchema.safeParse({ after: '0', hub: 'h1' }).success).toBe(false)
  })

  it('answers with changes, the high-water seq and whether more are waiting', () => {
    const change = { seq: 5, hubId: 'h1', itemId: 'i1', item: null }
    const page = { changes: [change], seq: 5, more: true }
    expect(changesPageSchema.parse(page)).toEqual(page)
    expect(changesPageSchema.safeParse({ changes: [], seq: 40, more: false }).success).toBe(true)
    expect(changesPageSchema.safeParse({ changes: [], more: false }).success).toBe(false)
    expect(
      changesPageSchema.safeParse({
        changes: Array.from({ length: MAX_CHANGES_LIMIT + 1 }, () => change),
        seq: 5,
        more: true,
      }).success,
    ).toBe(false)
  })
})
