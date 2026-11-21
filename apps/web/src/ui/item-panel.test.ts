// @vitest-environment client-node
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { activeElement, mount } from '../test/fake-dom.ts'
import ItemPanel from './ItemPanel.vue'

describe('ItemPanel focus', () => {
  it('takes focus when it opens, so keyboard and phone users land on it', async () => {
    const { root, get } = mount(ItemPanel, { title: 'BLD-4' })
    await nextTick()
    expect(activeElement(root)).toBe(get('h2'))
  })

  it('leaves focus where it is with keepFocus, as for the arrow keys in a table', async () => {
    const { root } = mount(ItemPanel, { title: 'BLD-4', keepFocus: true })
    await nextTick()
    expect(activeElement(root)).toBeUndefined()
  })
})
