import { BLOCK_TYPE_NAMES, BLOCK_TYPES, parseViewTree } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { description } from '../hub-settings/fixtures.test-utils.ts'
import { defaultConfig } from './defaults.ts'
import { blockForm } from './forms.ts'
import { BLOCK_LABELS, composerSchema, toTree, type DraftBlock } from './tree.ts'

// Every block type core knows has a form, a name and a starting config (Q10). A type added to
// `BLOCK_TYPES` fails here until the composer can edit it.

describe('the composer covers every block type', () => {
  it.each(BLOCK_TYPE_NAMES)('%s has a form and a label', (type) => {
    expect(blockForm(type), `no composer form for "${type}"`).toBeDefined()
    expect(BLOCK_LABELS[type]).toBeTruthy()
  })

  it('knows no type core does not', () => {
    expect(Object.keys(BLOCK_LABELS).sort()).toEqual(Object.keys(BLOCK_TYPES).sort())
  })

  it.each(BLOCK_TYPE_NAMES.filter((t) => t !== 'page'))(
    'a new %s block on a page is a valid tree for a folder with a select',
    (type) => {
      const schema = composerSchema(description())
      const root: DraftBlock = { id: 'page', type: 'page', config: {}, children: [] }
      // Fields and a burndown need an item-bound block: the day count is not here, so a
      // burndown starts with an empty range the form asks to fill.
      const block = { id: type, type, config: defaultConfig(type, schema, 'backlog', root) }
      const parsed = parseViewTree(toTree({ ...root, children: [block] }))
      expect(parsed.ok ? [] : parsed.errors).toEqual([])
    },
  )
})
