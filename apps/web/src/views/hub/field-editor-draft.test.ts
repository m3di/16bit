// @vitest-environment client-node
import type { Attribute } from '@16bit/core'
import { nextTick, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { findAll, fire, mount, type, type FakeNode } from '../../test/fake-dom.ts'
import FieldEditor from './FieldEditor.vue'
import { attributes } from './fixtures.test-utils.ts'

// A field the reader is typing in keeps their draft when someone else's change arrives (D60,
// decided by the maintainer during M3): the change is shown beside it, and the save goes out
// against the version the draft was based on, so it meets the usual conflict.

// The note and its buttons belong to FieldEditor; the actor and relation pickers need a hub's
// value context, which these tests do not set up.
vi.mock('./ActorEditor.vue', () => ({ default: { render: () => null } }))
vi.mock('./RelationEditor.vue', () => ({ default: { render: () => null } }))

const [title] = attributes as [Attribute]

const textOf = (n: FakeNode): string =>
  n.tag === '#text' ? n.text : n.children.map(textOf).join('')
const byData = (root: FakeNode, attr: string) =>
  findAll(root, (n) => n.props[attr] !== undefined)[0]
const buttons = (n: FakeNode) => findAll(n, (e) => e.tag === 'button')

const [base] = attributes as [Attribute]
const tags = {
  ...base,
  id: 'tags',
  name: 'Tags',
  type: 'multi_select',
  config: {
    options: [
      { id: 'ui', label: 'UI' },
      { id: 'api', label: 'API' },
    ],
  },
} as Attribute
const owners = {
  ...base,
  id: 'owners',
  name: 'Owners',
  type: 'actor',
  config: { multiple: true },
} as Attribute
const blocks = {
  ...base,
  id: 'blocks',
  name: 'Blocks',
  type: 'relation',
  config: { targetHubId: 'bld', crossHub: false, multiple: true },
} as Attribute

/** A field with its own editor, showing `value` at version 2, with `refused` offered back. */
function listField(attribute: Attribute, value: string[], refused: string[]) {
  const commits: [unknown, unknown][] = []
  const { root } = mount(
    FieldEditor,
    reactive({
      attribute,
      value,
      version: 2,
      itemId: 'i1',
      changedBy: 'Mina Park',
      refused: { value: refused, by: 'Mina Park' },
      onCommit: (v: unknown, basedOn: unknown) => commits.push([v, basedOn]),
    }),
  )
  return { note: byData(root, 'data-refused-draft') as FakeNode, commits }
}

function editor(start: { value: string; version: number }) {
  const props = {
    attribute: title,
    value: start.value as string | null,
    version: start.version,
    itemId: 'i1',
    changedBy: 'Mina Park',
    refused: null as { value: string; by: string } | null,
  }
  const commits: [unknown, unknown][] = []
  let dismissed = 0
  // A reactive props object: the render reads it, so changing it updates the editor.
  const all = reactive({
    ...props,
    onCommit: (value: unknown, basedOn: unknown) => commits.push([value, basedOn]),
    onDismissRefused: () => dismissed++,
  })
  const { get, root } = mount(FieldEditor, all)
  return { props: all, input: get('input'), root, commits, dismissed: () => dismissed }
}

describe('FieldEditor: a change from someone else while typing', () => {
  it('follows the value while the reader has not typed', async () => {
    const e = editor({ value: 'Old', version: 1 })
    e.props.value = 'Theirs'
    e.props.version = 2
    await nextTick()
    expect(e.input.value).toBe('Theirs')
    expect(byData(e.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('keeps the draft, says who changed it and to what, and saves against the old version', async () => {
    const e = editor({ value: 'Old', version: 1 })
    type(e.input, 'Mine')
    await nextTick()
    e.props.value = 'Theirs'
    e.props.version = 2
    await nextTick()
    expect(e.input.value).toBe('Mine')
    const note = byData(e.root, 'data-changed-while-editing')
    expect(note).toBeDefined()
    expect(textOf(note as FakeNode)).toContain(
      'Changed by Mina Park while you were editing: “Theirs”',
    )
    // Announced: the note is a polite live region.
    expect(findAll(note as FakeNode, (n) => n.props['role'] === 'status')).toHaveLength(1)
    fire(e.input, 'change')
    expect(e.commits).toEqual([['Mine', 1]])
    await nextTick()
    expect(byData(e.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('moves the base along when another field changed, so only this field conflicts', async () => {
    const e = editor({ value: 'Old', version: 1 })
    type(e.input, 'Mine')
    await nextTick()
    e.props.version = 2
    await nextTick()
    expect(byData(e.root, 'data-changed-while-editing')).toBeUndefined()
    fire(e.input, 'change')
    expect(e.commits).toEqual([['Mine', 2]])
  })

  it('shows their value without saving when the reader typed it back to what it was', async () => {
    const e = editor({ value: 'Old', version: 1 })
    type(e.input, 'Mi')
    await nextTick()
    e.props.value = 'Theirs'
    e.props.version = 2
    await nextTick()
    type(e.input, 'Old')
    await nextTick()
    fire(e.input, 'change')
    await nextTick()
    expect(e.commits).toEqual([])
    expect(e.input.value).toBe('Theirs')
  })

  it('offers the refused value back after a conflict: keep mine, or use the latest', async () => {
    const e = editor({ value: 'Theirs', version: 2 })
    e.props.refused = { value: 'Mine', by: 'Mina Park' }
    await nextTick()
    const note = byData(e.root, 'data-refused-draft') as FakeNode
    // Every queued edit is offered back, including fields the other person did not touch, so
    // the note does not claim they changed this one.
    expect(textOf(note)).toContain(
      'Mina Park changed this item while you were editing, so your Title “Mine” was not saved.',
    )
    expect(textOf(note)).toContain('The latest value is shown.')
    expect(textOf(note)).not.toContain('Theirs is shown')
    const [keep, latest] = buttons(note)
    expect(textOf(keep as FakeNode)).toBe('Keep mine')
    expect(textOf(latest as FakeNode)).toBe('Use latest')
    fire(latest as FakeNode, 'click')
    expect(e.dismissed()).toBe(1)
    fire(keep as FakeNode, 'click')
    // Saved over the version now shown, which the reader has seen.
    expect(e.commits).toEqual([['Mine', 2]])
  })

  it('says a save failed, not that someone changed it, when the reader is still typing', async () => {
    const e = editor({ value: 'Old', version: 1 })
    type(e.input, 'Mine')
    await nextTick()
    fire(e.input, 'change')
    // The pending edit shows, and the reader goes on typing.
    e.props.value = 'Mine'
    await nextTick()
    type(e.input, 'Mine and more')
    await nextTick()
    // The server refused the save (not a conflict): the value goes back, the version stays.
    e.props.value = 'Old'
    await nextTick()
    expect(e.input.value).toBe('Mine and more')
    const note = textOf(byData(e.root, 'data-changed-while-editing') as FakeNode)
    expect(note).toContain('Your last change was not saved, so the saved value is still “Old”.')
    expect(note).not.toContain('Changed by')
    // Saving again goes out against the same version, which the server still has.
    fire(e.input, 'change')
    expect(e.commits).toEqual([
      ['Mine', 1],
      ['Mine and more', 1],
    ])
  })

  it('follows a rolled-back value after a save, as before', async () => {
    const e = editor({ value: 'Old', version: 1 })
    type(e.input, 'Mine')
    await nextTick()
    fire(e.input, 'change')
    // The pending edit shows, then is dropped (the server refused it).
    e.props.value = 'Mine'
    await nextTick()
    e.props.value = 'Old'
    await nextTick()
    expect(e.input.value).toBe('Old')
    expect(byData(e.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('offers a refused multi-select value back by its option labels, and keeps it', () => {
    const f = listField(tags, ['api'], ['ui', 'api'])
    expect(textOf(f.note)).toContain('so your Tags “UI, API” was not saved.')
    const [keep] = buttons(f.note)
    fire(keep as FakeNode, 'click')
    // The whole list, over the version now shown, not parsed as input text.
    expect(f.commits).toEqual([[['ui', 'api'], 2]])
  })

  it.each([
    ['an actor', owners, 'Owners'],
    ['a relation', blocks, 'Blocks'],
  ])('offers %s value back without quoting IDs, and keeps it', (_, attribute, name) => {
    const f = listField(attribute, ['p1'], ['p1', 'p2'])
    const text = textOf(f.note)
    expect(text).toContain(`so your ${name} value was not saved.`)
    expect(text).not.toContain('p2')
    fire(buttons(f.note)[0] as FakeNode, 'click')
    expect(f.commits).toEqual([[['p1', 'p2'], 2]])
  })
})
