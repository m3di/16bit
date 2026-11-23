// @vitest-environment client-node
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findAll, mount, type FakeNode } from '../../test/fake-dom.ts'
import { homeData, homeTree } from './fixtures.test-utils.ts'
import { registerBlock } from './registry.ts'
import { readTree } from './render-tree.ts'
import type { BlockLoad } from './useRootView.ts'
import ViewRenderer from './ViewRenderer.vue'

// `v-text` sets `textContent`, which the fake DOM keeps as a prop.
const textOf = (n: FakeNode): string =>
  n.text +
  (typeof n.props['textContent'] === 'string' ? n.props['textContent'] : '') +
  n.children.map(textOf).join('')

const Throws = defineComponent({
  props: { block: { type: Object, required: true } },
  setup() {
    throw new Error('A block went wrong')
  },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('one broken block never breaks the page', () => {
  it('replaces only the block that threw, in the browser', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerBlock('number', Throws)
    const blocks: Record<string, BlockLoad> = Object.fromEntries(
      Object.entries(homeData().blocks).map(([id, status]) => [id, { state: 'ready', status }]),
    )
    const { root } = mount(ViewRenderer, {
      page: readTree(homeTree).page,
      folderName: 'Home',
      blocks,
      nameOf: () => 'Items',
    })
    await nextTick()
    const broken = findAll(root, (n) => n.props['data-block-broken'] !== undefined)
    expect(broken.map((n) => n.props['data-view-block'])).toEqual(['open', 'day'])
    const text = textOf(root)
    expect(text).toContain('This block could not be shown')
    expect(text).toContain('What the team is on.')
    expect(text).toContain('Backlog')
  })
})
