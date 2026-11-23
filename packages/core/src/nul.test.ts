import { describe, expect, it } from 'vitest'
import {
  attributeSchema,
  compileItemQuery,
  createItemSchema,
  itemCauseSchema,
  createAgentKeySchema,
  createAttributeSchema,
  createFolderSchema,
  createHubSchema,
  NUL_MESSAGE,
  updateAttributeSchema,
  updateFolderSchema,
  updateHubSchema,
  validateItemValues,
  type Attribute,
} from './index.ts'

// Postgres can't store U+0000 in text or jsonb, so the schemas refuse it before a write (#221).

const attr = (id: string, type: string, config: object = {}): Attribute =>
  attributeSchema.parse({
    workspaceId: 'w',
    id,
    hubId: 'h',
    name: id,
    type,
    config,
    indexed: true,
    version: 0,
  })

const title = attr('title', 'text')
const link = attr('link', 'url')
const notes = attr('notes', 'rich_text')
const fields = [title, link, notes].map((attribute) => ({ attribute, required: false }))

const doc = (text: string, href = 'https://e.example/') => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
    },
  ],
})

const errorsFor = (values: Record<string, unknown>) => {
  const result = validateItemValues(fields, values)
  return result.ok ? [] : result.errors.map((e) => e.attributeId)
}

describe('NUL in item values (#221)', () => {
  it('refuses it in text, URL and rich text values, and nowhere else changes', () => {
    expect(errorsFor({ title: 'a\u0000b' })).toEqual(['title'])
    expect(errorsFor({ link: 'https://e.example/a\u0000b' })).toEqual(['link'])
    expect(errorsFor({ notes: doc('a\u0000b') })).toEqual(['notes'])
    expect(errorsFor({ notes: doc('ab', 'https://e.example/\u0000') })).toEqual(['notes'])
    expect(
      errorsFor({ title: 'a\u0001b', link: 'https://e.example/ab', notes: doc('ab') }),
    ).toEqual([])
  })

  it('names the character in the message', () => {
    const result = validateItemValues(fields, { title: '\u0000' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain(NUL_MESSAGE)
  })
})

describe('NUL in causes and filters (#221)', () => {
  it('refuses it in a cause note and evidence URL', () => {
    expect(itemCauseSchema.safeParse({ note: 'why\u0000' }).success).toBe(false)
    expect(itemCauseSchema.safeParse({ evidence: ['https://e.example/\u0000'] }).success).toBe(
      false,
    )
    expect(itemCauseSchema.safeParse({ note: 'why' }).success).toBe(true)
    expect(createItemSchema.safeParse({ folderId: 'f1', cause: { note: '\u0000' } }).success).toBe(
      false,
    )
  })

  it('refuses it in a text filter operand', () => {
    const compile = (op: string, value: string) =>
      compileItemQuery([title], { where: { attribute: 'title', op: op as 'eq', value }, sort: [] })
        .ok
    expect(compile('contains', 'a\u0000')).toBe(false)
    expect(compile('eq', 'a\u0000')).toBe(false)
    expect(compile('contains', 'a')).toBe(true)
  })
})

describe('NUL in names (#285)', () => {
  const nul = 'a\u0000b'
  const refused = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => {
    expect(result.success).toBe(false)
    return result.error?.issues.map((i) => i.path.join('.'))
  }

  it('refuses it in hub, folder, attribute, option and agent key names, at the field', () => {
    expect(
      refused(createHubSchema.safeParse({ name: nul, color: 'blue', idPrefix: 'NUL' })),
    ).toEqual(['name'])
    expect(refused(updateHubSchema.safeParse({ version: 0, name: nul }))).toContain('name')
    expect(
      refused(createFolderSchema.safeParse({ parentId: 'h', name: nul, color: 'blue' })),
    ).toEqual(['name'])
    expect(refused(updateFolderSchema.safeParse({ version: 0, name: nul }))).toContain('name')
    expect(
      refused(createAttributeSchema.safeParse({ name: nul, type: 'text', config: {} })),
    ).toContain('name')
    expect(
      refused(
        createAttributeSchema.safeParse({
          name: 'Stage',
          type: 'select',
          config: { options: [{ id: 'a', label: nul }] },
        }),
      ),
    ).toContain('config.options.0.label')
    expect(refused(updateAttributeSchema.safeParse({ version: 0, name: nul }))).toContain('name')
    expect(refused(createAgentKeySchema.safeParse({ name: nul, hubRole: 'editor' }))).toEqual([
      'name',
    ])
  })

  it('still takes ordinary names', () => {
    expect(createHubSchema.safeParse({ name: 'Hub', color: 'blue', idPrefix: 'HUB' }).success).toBe(
      true,
    )
    expect(createAgentKeySchema.safeParse({ name: 'bot', hubRole: 'editor' }).success).toBe(true)
  })
})
