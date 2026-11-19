// @vitest-environment client-node
import type { Attribute } from '@16bit/core'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { fire, mount, type } from '../../test/fake-dom.ts'
import FieldEditor from './FieldEditor.vue'
import { attributes } from './fixtures.test-utils.ts'

// The New item form, the item panel, and the item page all edit values through FieldEditor.
// A typed value must reach `commit` as the stored type, for every type with a text input (#155).

const [text, , number] = attributes as [Attribute, Attribute, Attribute]
const date: Attribute = { ...text, id: 'due', type: 'date', config: { includeTime: false } }
const link: Attribute = { ...text, id: 'link', type: 'url', config: {} }

function editor(attribute: Attribute, value?: unknown) {
  const commits: unknown[] = []
  const { get } = mount(FieldEditor, {
    attribute,
    value,
    onCommit: (v: unknown) => commits.push(v),
  })
  return { input: get('input'), commits }
}

describe('FieldEditor commits', () => {
  it('saves a typed number as a number on change', async () => {
    const { input, commits } = editor(number)
    expect(input.props['type']).toBe('number')
    type(input, '3')
    await nextTick()
    fire(input, 'change')
    expect(commits).toEqual([3])
  })

  it('saves an edited number on Enter', async () => {
    const { input, commits } = editor(number, 3)
    expect(input.value).toBe('3')
    type(input, '8')
    await nextTick()
    fire(input, 'keydown', { key: 'Enter' })
    expect(commits).toEqual([8])
  })

  it('sends nothing when the number is unchanged, and clears it when emptied', async () => {
    const { input, commits } = editor(number, 3)
    fire(input, 'change')
    expect(commits).toEqual([])
    type(input, '')
    await nextTick()
    fire(input, 'change')
    expect(commits).toEqual([null])
  })

  it('saves text, date, and URL values as typed', async () => {
    for (const [attribute, typed] of [
      [text, 'Hello'],
      [date, '2026-12-01'],
      [link, 'https://16bit.info'],
    ] as const) {
      const { input, commits } = editor(attribute)
      type(input, typed)
      await nextTick()
      fire(input, 'change')
      expect(commits).toEqual([typed])
    }
  })
})
