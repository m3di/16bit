// @vitest-environment client-node
import { describe, expect, it } from 'vitest'
import { fire, mount, type } from '../test/fake-dom.ts'
import BaseInput from './BaseInput.vue'

// BaseInput's model is a string for every input type (#155). Vue's v-model casts the value of an
// <input type="number"> to a number, and FieldEditor's parser then called .trim() on it.

function mountInput(inputType: 'number' | 'text' | 'date') {
  const updates: unknown[] = []
  const { get } = mount(BaseInput, {
    label: 'Points',
    type: inputType,
    modelValue: '',
    'onUpdate:modelValue': (v: unknown) => updates.push(v),
  })
  return { input: get('input'), updates }
}

describe('BaseInput model', () => {
  it('keeps a number input value as the text typed', () => {
    const { input, updates } = mountInput('number')
    expect(input.props['type']).toBe('number')
    type(input, '3')
    type(input, '2.50')
    expect(updates).toEqual(['3', '2.50'])
  })

  it('passes text and date values through unchanged', () => {
    const text = mountInput('text')
    type(text.input, ' 007 ')
    expect(text.updates).toEqual([' 007 '])
    const date = mountInput('date')
    type(date.input, '2026-12-01')
    expect(date.updates).toEqual(['2026-12-01'])
  })

  it('waits for an IME composition to end', () => {
    const { input, updates } = mountInput('text')
    type(input, 'に', { isComposing: true })
    expect(updates).toEqual([])
    input.value = '日本'
    fire(input, 'compositionend')
    expect(updates).toEqual(['日本'])
  })
})
