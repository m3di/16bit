import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  CAUSE_NOTE_MAX_LENGTH,
  changeSchema,
  createItemSchema,
  deleteItemBodySchema,
  itemCauseSchema,
  MAX_CAUSE_EVIDENCE,
  patchItemSchema,
  revisionEntrySchema,
  revisionPageSchema,
  URL_MAX_LENGTH,
} from './index.ts'

// Causes on item writes and the item history read (D63, #197).

const url = (length: number) => `https://e.example/${'a'.repeat(length - 18)}`

describe('item cause (D63)', () => {
  const ok = (cause: unknown) => itemCauseSchema.safeParse(cause).success

  it('takes a note, evidence and causedBy, at least one of them', () => {
    expect(itemCauseSchema.parse({ note: '  why  ' })).toEqual({ note: 'why' })
    expect(ok({ evidence: ['https://e.example/1'] })).toBe(true)
    expect(ok({ causedBy: 1 })).toBe(true)
    expect(ok({ note: 'n', evidence: ['http://e.example'], causedBy: 7 })).toBe(true)
    expect(ok({})).toBe(false)
    expect(ok({ note: 'n', other: 1 })).toBe(false)
  })

  it('refuses each field at its limits', () => {
    expect(ok({ note: 'n'.repeat(CAUSE_NOTE_MAX_LENGTH) })).toBe(true)
    expect(ok({ note: 'n'.repeat(CAUSE_NOTE_MAX_LENGTH + 1) })).toBe(false)
    expect(ok({ note: ' \n ' })).toBe(false)

    const many = Array.from(
      { length: MAX_CAUSE_EVIDENCE },
      (_, i) => `https://e.example/${String(i)}`,
    )
    expect(ok({ evidence: many })).toBe(true)
    expect(ok({ evidence: [...many, 'https://e.example/x'] })).toBe(false)
    expect(ok({ evidence: [] })).toBe(false)
    expect(url(URL_MAX_LENGTH)).toHaveLength(URL_MAX_LENGTH)
    expect(ok({ evidence: [url(URL_MAX_LENGTH)] })).toBe(true)
    expect(ok({ evidence: [url(URL_MAX_LENGTH + 1)] })).toBe(false)
    for (const bad of ['/relative', 'mailto:a@e.example', 'javascript:alert(1)', 'e.example']) {
      expect(ok({ evidence: [bad] }), bad).toBe(false)
    }

    expect(ok({ causedBy: 0 })).toBe(false)
    expect(ok({ causedBy: 1.5 })).toBe(false)
    expect(ok({ causedBy: '1' })).toBe(false)
  })

  it('is optional on create, patch and the delete body', () => {
    expect(createItemSchema.parse({ folderId: 'f1' }).cause).toBeUndefined()
    expect(createItemSchema.parse({ folderId: 'f1', cause: { note: 'n' } }).cause).toEqual({
      note: 'n',
    })
    expect(
      patchItemSchema.safeParse({ version: 1, values: { a: 1 }, cause: { causedBy: 3 } }).success,
    ).toBe(true)
    expect(deleteItemBodySchema.parse({})).toEqual({})
    expect(deleteItemBodySchema.safeParse({ cause: {} }).success).toBe(false)
    expect(deleteItemBodySchema.safeParse({ version: 1 }).success).toBe(false)
  })

  it('has its own 422 code', () => {
    expect(API_ERROR_CODES).toContain('invalid_cause')
  })

  it('rides on a change, optionally', () => {
    const change = { seq: 3, hubId: 'h1', itemId: 'i1', item: null }
    expect(changeSchema.safeParse(change).success).toBe(true)
    expect(changeSchema.safeParse({ ...change, cause: { note: 'n' } }).success).toBe(true)
    expect(changeSchema.safeParse({ ...change, cause: null }).success).toBe(false)
  })
})

describe('item history (D63)', () => {
  const entry = {
    seq: 4,
    version: 2,
    op: 'update',
    patch: { op: 'update', values: { t1: 'x', t2: null } },
    actor: 'p1',
    at: '2026-11-21T10:00:00.000Z',
    cause: null,
  }

  it('describes each revision with its cause', () => {
    expect(revisionEntrySchema.safeParse(entry).success).toBe(true)
    expect(
      revisionEntrySchema.safeParse({
        ...entry,
        version: 1,
        op: 'create',
        patch: { op: 'create', folderId: 'f1', values: {} },
        cause: { causedBy: 1 },
      }).success,
    ).toBe(true)
    expect(
      revisionEntrySchema.safeParse({ ...entry, op: 'delete', patch: { op: 'delete' } }).success,
    ).toBe(true)
    expect(revisionEntrySchema.safeParse({ ...entry, cause: undefined }).success).toBe(false)
    expect(revisionEntrySchema.safeParse({ ...entry, op: 'move' }).success).toBe(false)
  })

  it('marks a patch it cannot read, keeping the rest of the entry (#222)', () => {
    const unreadable = { ...entry, patch: null, unreadable: true }
    expect(revisionEntrySchema.parse(unreadable)).toEqual(unreadable)
    expect(revisionEntrySchema.safeParse({ ...entry, patch: null }).success).toBe(false)
    expect(revisionEntrySchema.safeParse({ ...entry, unreadable: true }).success).toBe(false)
    expect(revisionEntrySchema.safeParse({ ...unreadable, unreadable: false }).success).toBe(false)
    expect(
      revisionPageSchema.parse({ items: [entry, unreadable], nextCursor: null }).items,
    ).toEqual([entry, unreadable])
  })

  it('pages like every other list', () => {
    expect(revisionPageSchema.parse({ items: [entry], nextCursor: 'abc' }).items).toHaveLength(1)
  })
})
