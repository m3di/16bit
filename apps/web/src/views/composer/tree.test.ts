import { describe, expect, it } from 'vitest'
import { description } from '../hub-settings/fixtures.test-utils.ts'
import { build, flatten, representable, valueEditor } from './conditions.ts'
import {
  addChild,
  checkDraft,
  composerSchema,
  configPath,
  draftFrom,
  getAt,
  moveBlock,
  newId,
  ownerOf,
  removeBlock,
  setAt,
  walk,
  type DraftBlock,
} from './tree.ts'

const page = (): DraftBlock => ({
  id: 'page',
  type: 'page',
  config: {},
  children: [
    { id: 'heading', type: 'heading', config: { text: 'Home', level: 2 } },
    { id: 'section', type: 'section', config: {}, children: [] },
    { id: 'text', type: 'text', config: { text: 'Hello' } },
  ],
})
const ids = (root: DraftBlock) => walk(root).map((l) => l.block.id)

describe('editing the outline', () => {
  it('adds only the child types a block allows, with unique IDs', () => {
    const root = page()
    expect(newId(root, 'heading')).toBe('heading-2')
    expect(newId(root, 'list')).toBe('list')
    expect(addChild(root, 'section', { id: 'list', type: 'list', config: {} })).toBe(true)
    // A heading holds nothing; a page is never a child.
    expect(addChild(root, 'heading', { id: 'x', type: 'text', config: {} })).toBe(false)
    expect(addChild(root, 'section', { id: 'p2', type: 'page', config: {} })).toBe(false)
    expect(ids(root)).toEqual(['page', 'heading', 'section', 'list', 'text'])
  })

  it('moves a block up and down among its siblings, and stops at the ends', () => {
    const root = page()
    expect(moveBlock(root, 'text', -1)).toBe(true)
    expect(ids(root)).toEqual(['page', 'heading', 'text', 'section'])
    expect(moveBlock(root, 'heading', -1)).toBe(false)
    expect(moveBlock(root, 'section', 1)).toBe(false)
    expect(moveBlock(root, 'page', 1)).toBe(false)
  })

  it('removes a block and what it holds, never the page', () => {
    const root = page()
    addChild(root, 'section', { id: 'list', type: 'list', config: {} })
    expect(removeBlock(root, 'section')).toBe(true)
    expect(ids(root)).toEqual(['page', 'heading', 'text'])
    expect(removeBlock(root, 'page')).toBe(false)
  })
})

describe('where a problem shows', () => {
  it('belongs to the deepest block its path starts with, and to a config path in it', () => {
    const blocks = walk(page())
    const e = { path: 'root.children.1.config.title', message: 'x' }
    expect(ownerOf(e, blocks)?.block.id).toBe('section')
    expect(configPath(e, 'root.children.1')).toBe('title')
    expect(ownerOf({ path: 'root.children.10.id', message: 'x' }, blocks)?.block.id).toBe('page')
    expect(ownerOf({ path: '', message: 'Too big' }, blocks)).toBeNull()
    expect(ownerOf({ path: 'root', message: 'Too many blocks' }, blocks)).toBeNull()
  })

  it('checks a draft with core: the shape first, then the hub’s schema', () => {
    const schema = composerSchema(description())
    const root = page()
    root.children?.push({
      id: 'list',
      type: 'list',
      config: { binding: { folderId: 'backlog', sort: [{ attribute: 'points' }], limit: 50 } },
    })
    // Points is not shown in Backlog.
    expect(checkDraft(root, schema).map((e) => e.path)).toEqual([
      'root.children.3.config.binding.sort.0',
    ])
    setAt(root.children?.[0]?.config ?? {}, 'text', undefined)
    expect(checkDraft(root, schema).map((e) => e.path)).toEqual(['root.children.0.config.text'])
  })
})

describe('config by path', () => {
  it('reads and writes nested values, making objects and removing keys', () => {
    const config: Record<string, unknown> = {}
    setAt(config, 'binding.where', { and: [] })
    setAt(config, 'binding.sort', [{ attribute: 'a' }, { attribute: 'b' }])
    setAt(config, 'binding.sort.0', undefined)
    expect(config).toEqual({ binding: { where: { and: [] }, sort: [{ attribute: 'b' }] } })
    expect(getAt(config, 'binding.sort.0.attribute')).toBe('b')
    setAt(config, 'binding.where', undefined)
    expect('where' in (config['binding'] as object)).toBe(false)
  })

  it('keeps a tree this build cannot read, block by block, for the admin to fix', () => {
    const root = draftFrom({
      schemaVersion: 1,
      root: {
        id: 'page',
        type: 'page',
        config: {},
        children: [
          { id: 'h', type: 'heading', config: { text: 'Hi' } },
          { id: 'n', type: 'nope', config: {} },
        ],
      },
    })
    expect(ids(root)).toEqual(['page', 'h'])
    expect(draftFrom(null)).toEqual({ id: 'page', type: 'page', config: {}, children: [] })
  })
})

describe('the condition list', () => {
  it('is one level of all or any; anything deeper is JSON', () => {
    const a = { attribute: 'stage', op: 'eq' as const, value: 'todo' }
    expect(flatten(undefined)).toEqual({ mode: 'and', rows: [] })
    expect(flatten(a)).toEqual({ mode: 'and', rows: [a] })
    expect(flatten({ or: [a] })).toEqual({ mode: 'or', rows: [a] })
    expect(flatten({ and: [{ or: [a] }] })).toBeNull()
    expect(build({ mode: 'and', rows: [] }, false)).toBeUndefined()
    expect(build({ mode: 'and', rows: [] }, true)).toEqual({ and: [] })
  })

  it('edits each type’s values, and leaves `$now` to JSON', () => {
    const d = description()
    const stage = d.attributes.find((x) => x.id === 'stage')
    const extras = { blocks: null, people: [] }
    const one = valueEditor(stage, 'eq', extras)
    expect(one.kind).toBe('one-of')
    expect(representable(one, 'todo')).toBe(true)
    expect(representable(one, { $now: 'P0D' })).toBe(false)
    expect(valueEditor(stage, 'is_empty', extras).kind).toBe('none')
    expect(valueEditor(stage, 'in', extras).kind).toBe('many')
  })
})
