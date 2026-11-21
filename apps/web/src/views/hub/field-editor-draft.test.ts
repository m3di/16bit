// @vitest-environment client-node
import type { Attribute } from '@16bit/core'
import { nextTick, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { findAll, fire, mount, type, type FakeNode } from '../../test/fake-dom.ts'
import FieldEditor from './FieldEditor.vue'
import { attributes } from './fixtures.test-utils.ts'

// A field the reader is typing in keeps their draft when someone else's change arrives (D60,
// decided by the maintainer during M3): the change is shown beside it, and the save goes out
// against the version the draft was based on, so it meets the usual conflict.

const [title] = attributes as [Attribute]

const textOf = (n: FakeNode): string =>
  n.tag === '#text' ? n.text : n.children.map(textOf).join('')
const byData = (root: FakeNode, attr: string) =>
  findAll(root, (n) => n.props[attr] !== undefined)[0]
const buttons = (n: FakeNode) => findAll(n, (e) => e.tag === 'button')

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

  it('offers the refused value back after a conflict: keep mine, or use theirs', async () => {
    const e = editor({ value: 'Theirs', version: 2 })
    e.props.refused = { value: 'Mine', by: 'Mina Park' }
    await nextTick()
    const note = byData(e.root, 'data-refused-draft') as FakeNode
    expect(textOf(note)).toContain('Mina Park changed Title while you were editing')
    expect(textOf(note)).toContain('“Mine” was not saved')
    const [keep, theirs] = buttons(note)
    expect(textOf(keep as FakeNode)).toBe('Keep mine')
    expect(textOf(theirs as FakeNode)).toBe('Use theirs')
    fire(theirs as FakeNode, 'click')
    expect(e.dismissed()).toBe(1)
    fire(keep as FakeNode, 'click')
    // Saved over the version now shown, which the reader has seen.
    expect(e.commits).toEqual([['Mine', 2]])
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
})
