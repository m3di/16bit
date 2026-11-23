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
    const errors: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((e: unknown) => errors.push(e))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerBlock('number', Throws)
    // Rows are router links, and this mount has no router: the list and board stay loading.
    const blocks: Record<string, BlockLoad> = Object.fromEntries(
      Object.entries(homeData().blocks).map(([id, status]): [string, BlockLoad] => [
        id,
        id === 'backlog' || id === 'in-sprint' ? { state: 'loading' } : { state: 'ready', status },
      ]),
    )
    const { root } = mount(ViewRenderer, {
      page: readTree(homeTree).page,
      folderName: 'Home',
      blocks,
      nameOf: () => 'Items',
    })
    await nextTick()
    // Only the block made to throw failed; nothing else did.
    expect(errors.map(String).filter((e) => !e.includes('A block went wrong'))).toEqual([])
    const broken = findAll(root, (n) => n.props['data-block-broken'] !== undefined)
    expect(broken.map((n) => n.props['data-view-block'])).toEqual(['open', 'day'])
    const text = textOf(root)
    expect(text).toContain('This block could not be shown')
    expect(text).toContain('What the team is on.')
    expect(text).toContain('Backlog')
  })
})
