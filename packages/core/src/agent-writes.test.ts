import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  batchRequestSchema,
  batchResponseSchema,
  batchResultSchema,
  createItemSchema,
  EXTERNAL_KEY_MAX_LENGTH,
  externalKeySchema,
  isServerClockValue,
  itemConditionSchema,
  itemSchema,
  MAX_BATCH_OPERATIONS,
  MAX_FILTER_CONDITIONS,
  MAX_SERVER_CLOCK_OFFSET_DAYS,
  MAX_SERVER_CLOCK_OFFSET_MS,
  patchItemSchema,
  preconditionFailedErrorSchema,
  relationKeyRefSchema,
  resolveServerClock,
  revisionPatchSchema,
  serverClockOffsetMs,
  serverClockValueSchema,
  upsertItemSchema,
  type Item,
} from './index.ts'

// Contracts for external keys (D64), batch writes (D65), and preconditions with server-clock
// values (D66), #199. The routes come in #200, #202 and #203.

const item: Item = {
  workspaceId: 'w1',
  id: 'i1',
  hubId: 'h1',
  folderId: 'f1',
  seqId: 1,
  values: { title: 'x' },
  version: 1,
  updatedAt: '2026-11-22T10:00:00.000Z',
  updatedBy: 'p1',
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('external key (D64)', () => {
  const ok = (key: unknown) => externalKeySchema.safeParse(key).success

  it('is 1 to 200 code points', () => {
    expect(ok('a')).toBe(true)
    expect(ok('k'.repeat(EXTERNAL_KEY_MAX_LENGTH))).toBe(true)
    expect(ok('k'.repeat(EXTERNAL_KEY_MAX_LENGTH + 1))).toBe(false)
    // Counted as Postgres counts: code points, not UTF-16 units.
    expect(ok('😀'.repeat(EXTERNAL_KEY_MAX_LENGTH))).toBe(true)
    expect(ok('😀'.repeat(EXTERNAL_KEY_MAX_LENGTH + 1))).toBe(false)
    expect(ok('')).toBe(false)
    expect(ok(1)).toBe(false)
    expect(ok(null)).toBe(false)
  })

  it('refuses the dot segments "." and "..", which no URL can reach (#200 review)', () => {
    expect(ok('.')).toBe(false)
    expect(ok('..')).toBe(false)
    expect(externalKeySchema.safeParse('.').error?.issues[0]?.message).toBe(
      'Not "." or "..": URLs resolve them as dot segments',
    )
    for (const fine of ['...', '.a', 'a.', './a', '../a', '. ', '%2E']) {
      expect(ok(fine), fine).toBe(fine !== '. ')
    }
  })

  it('is kept exactly as sent: never trimmed or folded', () => {
    expect(externalKeySchema.parse('Src/App.ts')).toBe('Src/App.ts')
    expect(externalKeySchema.parse('a b')).toBe('a b')
    expect(externalKeySchema.parse('A\u0308')).toBe('A\u0308')
  })

  it('refuses whitespace at either end and control characters anywhere', () => {
    for (const bad of [
      ' a',
      'a ',
      '\ta',
      'a\n',
      '\u00a0a',
      'a\u3000',
      '\ufeffa',
      'a\u2028',
      '\va',
      'a\f',
      '\u1680a',
      'a\u202f',
      '\u205fa',
      'a\u2029',
      '\u2000a',
      'a\u200a',
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const bad of [
      'a\u0000b',
      'a\tb',
      'a\rb',
      'a\u001fb',
      'a\u007fb',
      'a\u0085b',
      'a\u009fb',
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false)
    }
    // A lone surrogate would not survive as UTF-8.
    expect(ok('a\ud800b')).toBe(false)
    expect(ok('a\u2028b')).toBe(true)
    expect(ok('a\u200bb')).toBe(true)
  })

  it('is optional on items, create, and patch, and patch clears it with null', () => {
    expect(itemSchema.parse(item).externalKey).toBeUndefined()
    expect(itemSchema.parse({ ...item, externalKey: 'k' }).externalKey).toBe('k')
    expect(itemSchema.safeParse({ ...item, externalKey: null }).success).toBe(false)

    expect(createItemSchema.parse({ folderId: 'f1', externalKey: 'k' }).externalKey).toBe('k')
    expect(createItemSchema.safeParse({ folderId: 'f1', externalKey: ' k' }).success).toBe(false)
    expect(createItemSchema.safeParse({ folderId: 'f1', externalKey: null }).success).toBe(false)

    expect(patchItemSchema.parse({ version: 1, externalKey: 'k' })).toEqual({
      version: 1,
      externalKey: 'k',
      values: {},
    })
    expect(patchItemSchema.parse({ version: 1, externalKey: null }).externalKey).toBeNull()
    expect(patchItemSchema.parse({ version: 1, values: { a: 1 } }).externalKey).toBeUndefined()
  })

  it('requires a patch to change a value or the key', () => {
    const result = patchItemSchema.safeParse({ version: 1 })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]).toMatchObject({
      path: ['values'],
      message: 'At least one value or externalKey is required',
    })
    expect(patchItemSchema.safeParse({ version: 1, values: {} }).success).toBe(false)
  })

  it('is recorded in revision patches when a write set it', () => {
    const ok = (patch: unknown) => revisionPatchSchema.safeParse(patch).success
    expect(ok({ op: 'create', folderId: 'f1', values: {} })).toBe(true)
    expect(ok({ op: 'create', folderId: 'f1', externalKey: 'k', values: {} })).toBe(true)
    expect(ok({ op: 'create', folderId: 'f1', externalKey: null, values: {} })).toBe(false)
    expect(ok({ op: 'update', externalKey: 'k', values: {} })).toBe(true)
    expect(ok({ op: 'update', externalKey: null, values: {} })).toBe(true)
    expect(ok({ op: 'delete', externalKey: 'k' })).toBe(false)
  })

  it('names a relation target by key inside a batch', () => {
    expect(relationKeyRefSchema.parse({ externalKey: 'k' })).toEqual({ externalKey: 'k' })
    expect(relationKeyRefSchema.safeParse({ externalKey: '' }).success).toBe(false)
    expect(relationKeyRefSchema.safeParse({ externalKey: 'k', hubId: 'h1' }).success).toBe(false)
  })
})

describe('upsert by key (D64)', () => {
  it('takes a folder, values, and optionally a version, condition, mutation ID and cause', () => {
    expect(upsertItemSchema.parse({ folderId: 'f1' })).toEqual({ folderId: 'f1', values: {} })
    const full = {
      folderId: 'f1',
      values: { title: 'x' },
      version: 3,
      condition: { attribute: 'owner', op: 'is_empty' },
      clientMutationId: uuid(1),
      cause: { note: 'claim' },
    }
    expect(upsertItemSchema.parse(full)).toEqual(full)
  })

  it('refuses a missing folder, a bad version, and fields the path already holds', () => {
    const ok = (body: unknown) => upsertItemSchema.safeParse(body).success
    expect(ok({ values: {} })).toBe(false)
    expect(ok({ folderId: 'f1', version: 0 })).toBe(false)
    expect(ok({ folderId: 'f1', version: 1.5 })).toBe(false)
    expect(ok({ folderId: 'f1', externalKey: 'k' })).toBe(false)
    expect(ok({ folderId: 'f1', id: 'i1' })).toBe(false)
    expect(ok({ folderId: 'f1', clientMutationId: 'not-a-uuid' })).toBe(false)
  })

  it('answers key_taken (409) and precondition_failed (412) as their own codes', () => {
    expect(API_ERROR_CODES).toContain('key_taken')
    expect(API_ERROR_CODES).toContain('precondition_failed')
  })
})

describe('write preconditions (D66)', () => {
  const condition = (n: number) => ({
    and: Array.from({ length: n }, (_, i) => ({ attribute: `a${String(i)}`, op: 'is_empty' })),
  })

  it('is the query filter tree with its limits, on patch and upsert', () => {
    expect(itemConditionSchema.safeParse(condition(MAX_FILTER_CONDITIONS)).success).toBe(true)
    expect(itemConditionSchema.safeParse(condition(MAX_FILTER_CONDITIONS + 1)).success).toBe(false)
    const deep = { and: [{ or: [{ and: [{ attribute: 'a', op: 'is_empty' }] }] }] }
    expect(itemConditionSchema.safeParse(deep).success).toBe(false)
    expect(itemConditionSchema.safeParse({ attribute: 'a', op: 'like' }).success).toBe(false)

    const claim = {
      or: [
        { attribute: 'owner', op: 'is_empty' },
        { attribute: 'leaseUntil', op: 'lt', value: { $now: 'PT0S' } },
      ],
    }
    expect(
      patchItemSchema.parse({ version: 1, values: { a: 1 }, condition: claim }).condition,
    ).toEqual(claim)
    expect(upsertItemSchema.parse({ folderId: 'f1', condition: claim }).condition).toEqual(claim)
    expect(
      patchItemSchema.safeParse({ version: 1, values: { a: 1 }, condition: condition(21) }).success,
    ).toBe(false)
  })

  it('fails with the current item, or null when an upsert found none', () => {
    const failed = { error: 'precondition_failed', message: 'Condition not met' }
    expect(preconditionFailedErrorSchema.parse({ ...failed, current: item }).current).toEqual(item)
    expect(preconditionFailedErrorSchema.parse({ ...failed, current: null }).current).toBeNull()
    expect(preconditionFailedErrorSchema.safeParse(failed).success).toBe(false)
    expect(
      preconditionFailedErrorSchema.safeParse({ ...failed, error: 'conflict', current: item })
        .success,
    ).toBe(false)
  })
})

describe('server-clock values (D66)', () => {
  const H = 3_600_000
  const D = 24 * H

  it('reads weeks, days, hours, minutes and seconds, with a leading minus', () => {
    expect(serverClockOffsetMs('PT45M')).toBe(45 * 60_000)
    expect(serverClockOffsetMs('-P1D')).toBe(-D)
    expect(serverClockOffsetMs('P1W2DT3H4M5S')).toBe(9 * D + 3 * H + 4 * 60_000 + 5000)
    expect(serverClockOffsetMs('PT0.5S')).toBe(500)
    expect(serverClockOffsetMs('PT1.25S')).toBe(1250)
    expect(serverClockOffsetMs('PT0S')).toBe(0)
    expect(Object.is(serverClockOffsetMs('-PT0S'), 0)).toBe(true)
    expect(serverClockOffsetMs('PT90M')).toBe(90 * 60_000)
  })

  it('caps offsets at 366 days either way', () => {
    expect(MAX_SERVER_CLOCK_OFFSET_MS).toBe(MAX_SERVER_CLOCK_OFFSET_DAYS * D)
    expect(serverClockOffsetMs('P366D')).toBe(366 * D)
    expect(serverClockOffsetMs('-P366D')).toBe(-366 * D)
    expect(serverClockOffsetMs('P366DT0.001S')).toBeNull()
    expect(serverClockOffsetMs('-P52WT8785H')).toBeNull()
    expect(serverClockOffsetMs('PT8784H')).toBe(366 * D)
    expect(serverClockOffsetMs('PT999999999H')).toBeNull()
  })

  it('refuses calendar units and anything that is not this form', () => {
    for (const bad of [
      'P1Y',
      'P1M',
      'P1Y2D',
      'P',
      'PT',
      'P1DT',
      '+P1D',
      'p1d',
      'P1d',
      'PT1H30',
      'PT0.1234S',
      'PT1.5M',
      'P-1D',
      '1D',
      ' PT1H',
      'PT1H ',
      'P1DT1H1M1S1',
      '',
    ]) {
      expect(serverClockOffsetMs(bad), bad).toBeNull()
      expect(serverClockValueSchema.safeParse({ $now: bad }).success, bad).toBe(false)
    }
  })

  it('is a strict { $now } object', () => {
    expect(serverClockValueSchema.parse({ $now: '-P1D' })).toEqual({ $now: '-P1D' })
    expect(serverClockValueSchema.safeParse({ $now: 'PT1H', extra: 1 }).success).toBe(false)
    expect(serverClockValueSchema.safeParse({ $now: 3600 }).success).toBe(false)
    expect(serverClockValueSchema.safeParse({ $now: 'P'.padEnd(65, '0') }).success).toBe(false)
    expect(isServerClockValue({ $now: 'PT1H' })).toBe(true)
    expect(isServerClockValue({ $now: 1 })).toBe(true)
    expect(isServerClockValue('2026-11-22')).toBe(false)
    expect(isServerClockValue(['$now'])).toBe(false)
    expect(isServerClockValue(null)).toBe(false)
  })

  it('resolves against the given clock, to a UTC date-time or calendar date', () => {
    const now = new Date('2026-11-22T23:30:00.250Z')
    expect(resolveServerClock({ $now: 'PT45M' }, now, true)).toBe('2026-11-23T00:15:00.250Z')
    expect(resolveServerClock({ $now: 'PT45M' }, now, false)).toBe('2026-11-23')
    expect(resolveServerClock({ $now: '-P1D' }, now, true)).toBe('2026-11-21T23:30:00.250Z')
    expect(resolveServerClock({ $now: 'PT0S' }, now, false)).toBe('2026-11-22')
    expect(() => resolveServerClock({ $now: 'P1Y' }, now, true)).toThrow()
  })
})

describe('batch writes (D65)', () => {
  const create = (n: number) => ({ op: 'create', folderId: 'f1', clientMutationId: uuid(n) })

  it('takes 1 to 100 operations', () => {
    const ok = (operations: unknown[]) => batchRequestSchema.safeParse({ operations }).success
    expect(ok([])).toBe(false)
    expect(ok([create(1)])).toBe(true)
    const many = Array.from({ length: MAX_BATCH_OPERATIONS }, (_, i) => create(i))
    expect(ok(many)).toBe(true)
    expect(ok([...many, create(MAX_BATCH_OPERATIONS)])).toBe(false)
    expect(batchRequestSchema.safeParse({ operations: [create(1)], atomic: true }).success).toBe(
      false,
    )
  })

  it('takes each operation in the shape of its route', () => {
    const parsed = batchRequestSchema.parse({
      operations: [
        {
          op: 'create',
          id: 'i1',
          folderId: 'f1',
          externalKey: 'a.ts',
          values: { title: 'A', links: [{ externalKey: 'b.ts' }] },
          cause: { note: 'n' },
        },
        { op: 'patch', id: 'i1', version: 1, values: { title: 'B' }, externalKey: null },
        {
          op: 'patch',
          id: 'i2',
          version: 4,
          values: { owner: ['p1'], leaseUntil: { $now: 'PT10M' } },
          condition: { attribute: 'owner', op: 'is_empty' },
        },
        { op: 'delete', id: 'i3', version: 2, clientMutationId: uuid(1), cause: { causedBy: 9 } },
        { op: 'upsert', hubId: 'h1', key: 'b.ts', folderId: 'f1', values: { title: 'B' } },
      ],
    })
    expect(parsed.operations.map((o) => o.op)).toEqual([
      'create',
      'patch',
      'patch',
      'delete',
      'upsert',
    ])
    expect(parsed.operations[4]).toEqual({
      op: 'upsert',
      hubId: 'h1',
      key: 'b.ts',
      folderId: 'f1',
      values: { title: 'B' },
    })
  })

  it('refuses the whole batch when one operation is malformed, naming it', () => {
    const fail = (operation: unknown) => {
      const result = batchRequestSchema.safeParse({ operations: [create(1), operation] })
      expect(result.success, JSON.stringify(operation)).toBe(false)
      return result.error?.issues[0]?.path
    }
    expect(fail({ op: 'move', id: 'i1' })).toEqual(['operations', 1, 'op'])
    expect(fail({ op: 'patch', id: 'i1', version: 1 })).toEqual(['operations', 1, 'values'])
    expect(fail({ op: 'patch', id: 'i1', values: { a: 1 } })).toEqual(['operations', 1, 'version'])
    fail({ op: 'delete', id: 'i1' })
    fail({ op: 'delete', id: 'i1', version: 1, condition: { attribute: 'a', op: 'is_empty' } })
    fail({ op: 'create', folderId: 'f1', condition: { attribute: 'a', op: 'is_empty' } })
    fail({ op: 'upsert', hubId: 'h1', folderId: 'f1' })
    fail({ op: 'upsert', key: 'k', folderId: 'f1' })
    fail({ op: 'upsert', hubId: 'h1', key: ' k', folderId: 'f1' })
    fail({ op: 'upsert', hubId: 'h1', key: 'k', folderId: 'f1', externalKey: 'k' })
  })

  it('refuses one clientMutationId on two operations', () => {
    const result = batchRequestSchema.safeParse({
      operations: [create(1), create(2), { ...create(1), folderId: 'f2' }],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]).toMatchObject({
      path: ['operations', 2, 'clientMutationId'],
      message: 'Operation 0 already uses this clientMutationId',
    })
    // Operations without one never collide.
    const bare = { op: 'create', folderId: 'f1' }
    expect(batchRequestSchema.safeParse({ operations: [bare, bare] }).success).toBe(true)
  })

  it('answers one result per operation: written, deleted, or the error its route gives', () => {
    const written = { status: 201, item: { ...item, externalKey: 'a.ts', seq: 7 } }
    const patched = { status: 200, item: { ...item, version: 2, seq: 8 } }
    const deleted = { status: 204, seq: 9 }
    const conflict = { status: 409, error: { error: 'conflict', message: 'm', current: item } }
    const failed = {
      status: 412,
      error: { error: 'precondition_failed', message: 'm', current: null },
    }
    const invalid = {
      status: 422,
      error: { error: 'invalid_values', message: 'm', errors: [{ attributeId: 'a' }] },
    }
    const response = { results: [written, patched, deleted, conflict, failed, invalid] }
    expect(batchResponseSchema.parse(response)).toEqual(response)

    const ok = (result: unknown) => batchResultSchema.safeParse(result).success
    expect(ok({ status: 201, item })).toBe(false) // a written item carries its seq
    expect(ok({ status: 204 })).toBe(false)
    expect(ok({ status: 202, item: written.item })).toBe(false)
    expect(ok({ status: 399, error: { error: 'conflict', message: 'm' } })).toBe(false)
    expect(ok({ status: 404, error: { error: 'nope', message: 'm' } })).toBe(false)
    expect(batchResponseSchema.safeParse({ results: [] }).success).toBe(false)
    expect(
      batchResponseSchema.safeParse({ results: Array(MAX_BATCH_OPERATIONS + 1).fill(deleted) })
        .success,
    ).toBe(false)
  })
})
