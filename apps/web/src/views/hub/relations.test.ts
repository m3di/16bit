import { validateItemValues, type FolderAttributeDefinition } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { description, item } from './fixtures.test-utils.ts'
import {
  chipView,
  itemTitle,
  listValue,
  multiSelectToggled,
  readableTarget,
  showsLoadedOnlyNote,
  toggled,
} from './relations.ts'
import { folderColumns } from './useHub.ts'

const hubOf = () => description

describe('item titles', () => {
  it('uses the first text attribute of the folder', () => {
    const columns = folderColumns(description, 'bld')
    expect(itemTitle(item('i1', 4, { title: ' Ship it ', points: 3 }), columns)).toBe('Ship it')
    expect(itemTitle(item('i1', 4, { points: 3 }), columns)).toBe('')
    expect(itemTitle(item('i1', 4, { title: 'x' }), [])).toBe('')
  })

  it('makes a chip with the display ID and title, or the display ID alone', () => {
    expect(readableTarget(item('i1', 4, { title: 'Ship' }), description)).toEqual({
      access: 'ok',
      id: 'i1',
      title: 'Ship',
      displayId: 'BLD-4',
    })
    expect(readableTarget(item('i1', 4), description)).toEqual({
      access: 'ok',
      id: 'i1',
      title: 'BLD-4',
    })
  })
})

describe('chipView', () => {
  const read = { access: 'read' as const, item: item('t1', 9, { title: 'Target' }) }

  it('shows a readable item with its title', () => {
    expect(chipView('t1', read, hubOf)).toMatchObject({
      state: 'ready',
      target: { access: 'ok', title: 'Target', displayId: 'BLD-9' },
    })
  })

  it('shows "no access" without any value of the item', () => {
    expect(chipView('t1', { access: 'none' }, hubOf)).toEqual({
      state: 'ready',
      target: { access: 'none', id: 't1' },
      item: null,
    })
  })

  it('hides a deleted item and waits for unknown ones and their hub', () => {
    expect(chipView('t1', { access: 'gone' }, hubOf)).toBeNull()
    expect(chipView('t1', { access: 'unknown' }, hubOf)).toEqual({ state: 'loading' })
    expect(chipView('t1', { access: 'error' }, hubOf)).toEqual({ state: 'error' })
    expect(chipView('t1', read, () => 'loading')).toEqual({ state: 'loading' })
    expect(chipView('t1', read, () => 'error')).toEqual({ state: 'error' })
  })
})

describe('list values', () => {
  it('reads lists and ignores anything else', () => {
    expect(listValue(['a', 'b'])).toEqual(['a', 'b'])
    expect(listValue(null)).toEqual([])
    expect(listValue('a')).toEqual([])
  })

  it('adds, removes, replaces, and stores an empty list as null', () => {
    expect(toggled(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a', true)).toEqual(['b', 'a'])
    expect(toggled(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(toggled(['a'], 'a', false)).toBeNull()
    expect(toggled(['a'], 'b', true, false)).toEqual(['b'])
  })
})

describe('multi-select commits (#50)', () => {
  const options = [
    { id: 'ui', label: 'UI' },
    { id: 'api', label: 'API' },
  ]
  const columns: FolderAttributeDefinition[] = [
    {
      attribute: {
        workspaceId: 'w',
        id: 'tags',
        hubId: 'bld',
        name: 'Tags',
        indexed: false,
        type: 'multi_select',
        config: { options },
      },
      required: false,
    },
  ]
  const accepted = (value: string[] | null) =>
    validateItemValues(columns, { tags: value }, { partial: true }).ok

  it('drops deleted options when a live one is ticked, so core accepts the value', () => {
    expect(accepted(['api', 'gone'])).toBe(false)
    const next = multiSelectToggled(['api', 'gone', 'gone2'], options, 'ui', true)
    expect(next).toEqual(['api', 'ui'])
    expect(accepted(next)).toBe(true)
  })

  it('drops every deleted option when one of them is unticked', () => {
    const next = multiSelectToggled(['gone', 'gone2'], options, 'gone', false)
    expect(next).toBeNull()
    expect(accepted(next)).toBe(true)
  })
})

describe('picker notes', () => {
  it('says matches are among the loaded items only above a list of matches', () => {
    expect(showsLoadedOnlyNote(true, 'ship', 2)).toBe(true)
    // No match: "No matches among the items loaded so far" stands alone.
    expect(showsLoadedOnlyNote(true, 'ship', 0)).toBe(false)
    expect(showsLoadedOnlyNote(true, '', 2)).toBe(false)
    expect(showsLoadedOnlyNote(false, 'ship', 2)).toBe(false)
  })
})
