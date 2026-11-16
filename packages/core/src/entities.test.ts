import { describe, expect, it } from 'vitest'
import { folderSchema, idSchema, PALETTE_COLORS } from './index.ts'

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success

describe('idSchema', () => {
  it('accepts letters, digits, underscore, and hyphen up to 64 characters', () => {
    expect(accepts(idSchema, 'abc_DEF-123')).toBe(true)
    expect(accepts(idSchema, 'a'.repeat(64))).toBe(true)
  })

  it('rejects empty, too long, and unsafe IDs', () => {
    for (const id of ['', 'a'.repeat(65), 'a b', 'a/b', 'a.b', 'é', '../x', '#1']) {
      expect(accepts(idSchema, id), id).toBe(false)
    }
  })

  it('rejects __proto__, which matches the character set but cannot be an object key', () => {
    expect(accepts(idSchema, '__proto__')).toBe(false)
    expect(accepts(idSchema, '__proto')).toBe(true)
  })
})

describe('folderSchema.color', () => {
  const folder = {
    workspaceId: 'w1',
    id: 'f1',
    hubId: 'f1',
    parentId: null,
    name: 'Build',
    color: 'indigo',
    idPrefix: 'BLD',
    itemCount: 0,
    version: 0,
  }

  it('has exactly the 16 palette names', () => {
    expect(PALETTE_COLORS).toHaveLength(16)
  })

  it('accepts every palette name and rejects hex or unknown names', () => {
    for (const color of PALETTE_COLORS)
      expect(accepts(folderSchema, { ...folder, color })).toBe(true)
    expect(accepts(folderSchema, { ...folder, color: '#ff0000' })).toBe(false)
    expect(accepts(folderSchema, { ...folder, color: 'purple' })).toBe(false)
  })
})
