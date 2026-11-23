// @vitest-environment client-node
import type { Attribute } from '@16bit/core'
import { nextTick, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { findAll, fire, mount, type FakeNode } from '../../test/fake-dom.ts'
import { excerpt } from './field-draft.ts'
import FieldEditor from './FieldEditor.vue'
import { attributes } from './fixtures.test-utils.ts'

// Rich text follows the same draft rule as the other fields (D60, decided by the maintainer
// during M3): what the reader wrote is kept when someone else's change arrives, the change is
// shown beside it, and the save on blur goes out against the version the draft was based on.

// Tiptap needs a real DOM. The stand-in keeps the editor's contract: a v-model and a blur.
interface StubEditor {
  model: () => unknown
  write: (doc: unknown) => void
  blur: () => void
}
const editor = vi.hoisted(() => ({ current: null as StubEditor | null }))
const loaded = (): StubEditor | null => editor.current
vi.mock('../../ui/RichTextEditor.vue', async () => {
  const { defineComponent, h } = await import('vue')
  // Marked as a module, so defineAsyncComponent takes its default export.
  return {
    __esModule: true,
    default: defineComponent({
      props: {
        modelValue: { type: null, default: null },
        label: { type: String, default: '' },
        error: { type: String, default: '' },
        state: { type: String, default: 'ready' },
      },
      emits: ['update:modelValue', 'blur'],
      setup(props, { emit }) {
        editor.current = {
          model: (): unknown => props.modelValue,
          write: (doc) => {
            emit('update:modelValue', doc)
          },
          blur: () => {
            emit('blur')
          },
        }
        return () => h('div', { 'data-editor': '' })
      },
    }),
  }
})

const [title] = attributes as [Attribute]
const notes: Attribute = { ...title, id: 'notes', name: 'Notes', type: 'rich_text', config: {} }

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const textOf = (n: FakeNode): string =>
  n.tag === '#text' ? n.text : n.children.map(textOf).join('')
const byData = (root: FakeNode, attr: string) =>
  findAll(root, (n) => n.props[attr] !== undefined)[0]
const buttons = (n: FakeNode) => findAll(n, (e) => e.tag === 'button')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function field(start: { value: string; version: number }) {
  const commits: [unknown, unknown][] = []
  const props = reactive({
    attribute: notes,
    value: doc(start.value),
    version: start.version,
    itemId: 'i1',
    changedBy: 'Mina Park',
    refused: null as { value: unknown; by: string } | null,
    onCommit: (value: unknown, basedOn: unknown) => commits.push([value, basedOn]),
  })
  editor.current = null
  const { root } = mount(FieldEditor, props)
  // The editor is loaded on demand.
  await settle()
  const e = loaded()
  if (!e) throw new Error('the rich text editor did not load')
  return { props, root, commits, editor: e }
}

describe('Rich text: a change from someone else while writing', () => {
  it('follows the value while the reader has not written anything', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.props.value = doc('Theirs')
    f.props.version = 2
    await nextTick()
    expect(f.editor.model()).toEqual(doc('Theirs'))
    expect(byData(f.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('keeps the draft, says who changed it and to what, and saves against the old version', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write(doc('Mine'))
    await nextTick()
    f.props.value = doc('Theirs')
    f.props.version = 2
    await nextTick()
    expect(f.editor.model()).toEqual(doc('Mine'))
    const note = byData(f.root, 'data-changed-while-editing') as FakeNode
    expect(textOf(note)).toContain('Changed by Mina Park while you were editing: “Theirs”')
    // Announced: the note is a polite live region.
    expect(findAll(note, (n) => n.props['role'] === 'status')).toHaveLength(1)
    f.editor.blur()
    expect(f.commits).toEqual([[doc('Mine'), 1]])
    await nextTick()
    expect(byData(f.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('moves the base along when another field changed, so only this field conflicts', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write(doc('Mine'))
    await nextTick()
    f.props.version = 2
    await nextTick()
    expect(byData(f.root, 'data-changed-while-editing')).toBeUndefined()
    f.editor.blur()
    expect(f.commits).toEqual([[doc('Mine'), 2]])
  })

  it('shows their value without saving when the reader wrote it back to what it was', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write(doc('Mi'))
    await nextTick()
    f.props.value = doc('Theirs')
    f.props.version = 2
    await nextTick()
    f.editor.write(doc('Old'))
    await nextTick()
    f.editor.blur()
    await nextTick()
    expect(f.commits).toEqual([])
    expect(f.editor.model()).toEqual(doc('Theirs'))
    expect(byData(f.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('quotes a long change as one shortened line', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write(doc('Mine'))
    await nextTick()
    const long = `${'word '.repeat(40)}end`
    f.props.value = doc(long)
    f.props.version = 2
    await nextTick()
    const note = textOf(byData(f.root, 'data-changed-while-editing') as FakeNode)
    expect(note).toContain(`“${excerpt(long)}”`)
    expect(note).not.toContain('end”')
  })

  it('says a save failed, not that someone changed it, when the reader is still writing', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write(doc('Mine'))
    await nextTick()
    f.editor.blur()
    // The pending edit shows, and the reader goes on writing.
    f.props.value = doc('Mine')
    await nextTick()
    f.editor.write(doc('Mine and more'))
    await nextTick()
    // The server refused the save: the value goes back and the version stays.
    f.props.value = doc('Old')
    await nextTick()
    expect(f.editor.model()).toEqual(doc('Mine and more'))
    const note = textOf(byData(f.root, 'data-changed-while-editing') as FakeNode)
    expect(note).toContain('Your last change was not saved, so the saved value is still “Old”.')
    expect(note).not.toContain('Changed by')
  })

  it('follows a rolled-back value after a save when the reader stopped writing', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write(doc('Mine'))
    await nextTick()
    f.editor.blur()
    f.props.value = doc('Mine')
    await nextTick()
    f.props.value = doc('Old')
    await nextTick()
    expect(f.editor.model()).toEqual(doc('Old'))
    expect(byData(f.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('offers a refused document back, quoted as text, and keeps it over the latest version', async () => {
    const f = await field({ value: 'Theirs', version: 2 })
    f.props.refused = { value: doc('Mine'), by: 'Mina Park' }
    await nextTick()
    const note = byData(f.root, 'data-refused-draft') as FakeNode
    expect(textOf(note)).toContain(
      'Mina Park changed this item while you were editing, so your Notes “Mine” was not saved.',
    )
    const [keep] = buttons(note)
    fire(keep as FakeNode, 'click')
    expect(f.commits).toEqual([[doc('Mine'), 2]])
  })

  it('drops what was written since when the reader keeps the refused document', async () => {
    const f = await field({ value: 'Theirs', version: 2 })
    f.props.refused = { value: doc('Mine'), by: 'Mina Park' }
    f.editor.write(doc('Something else'))
    await nextTick()
    fire(buttons(byData(f.root, 'data-refused-draft') as FakeNode)[0] as FakeNode, 'click')
    expect(f.commits).toEqual([[doc('Mine'), 2]])
    await nextTick()
    expect(f.editor.model()).toEqual(doc('Mine'))
    // The save shows at the same version: that is not a failed save.
    f.props.value = doc('Mine')
    f.props.refused = null
    await nextTick()
    expect(byData(f.root, 'data-changed-while-editing')).toBeUndefined()
  })

  it('clears the value when the reader empties the document', async () => {
    const f = await field({ value: 'Old', version: 1 })
    f.editor.write({ type: 'doc', content: [{ type: 'paragraph' }] })
    await nextTick()
    f.editor.blur()
    expect(f.commits).toEqual([[null, 1]])
  })
})

describe('excerpt', () => {
  it('keeps short text and shortens long text to one line', () => {
    expect(excerpt('two\n\nlines')).toBe('two lines')
    expect(excerpt('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`)
  })
})
