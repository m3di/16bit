// @vitest-environment client-node
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeElement, findAll, mount, type FakeNode } from '../test/fake-dom.ts'
import FormNotice from './FormNotice.vue'
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

// Below `lg` the panel is a full-screen sheet over the page (D85): the page's own notice is then
// behind it and inert, so a failed write is reported inside the sheet too (#313 review).
describe('ItemPanel as a sheet', () => {
  let changed: (() => void) | undefined
  let narrow = true
  beforeEach(() => {
    narrow = true
    vi.stubGlobal('window', {
      matchMedia: () => ({
        get matches() {
          return !narrow
        },
        addEventListener: (_: string, fn: () => void) => {
          changed = fn
        },
        removeEventListener: () => undefined,
      }),
    })
    vi.stubGlobal('document', {
      body: null,
      activeElement: null,
      documentElement: { style: { overflow: '' } },
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const WithNotice = defineComponent({
    setup: () => () =>
      h(
        ItemPanel,
        { title: 'BLD-4', keepFocus: true },
        {
          notice: () => h(FormNotice, null, () => 'Your change to Status was not saved.'),
          default: () => 'Body',
        },
      ),
  })
  const texts = (n: FakeNode): string => n.text + n.children.map(texts).join('')
  const alerts = (root: FakeNode) => findAll(root, (n) => n.props['role'] === 'alert')
  const scrollBox = (root: FakeNode) => findAll(root, (n) => 'data-item-panel-scroll' in n.props)
  const sheetNotice = (root: FakeNode) => findAll(root, (n) => 'data-sheet-notice' in n.props)
  const overflow = () => document.documentElement as unknown as { style: { overflow: string } }

  it('shows a failed write inside the sheet as an alert, so it is seen and announced', async () => {
    const { root } = mount(WithNotice, {})
    await nextTick()
    const [scroll] = scrollBox(root)
    expect(scroll?.props['role']).toBe('dialog')
    expect(scroll?.props['aria-modal']).toBe('true')
    const [notice] = sheetNotice(root)
    const [alert] = notice ? alerts(notice) : []
    expect(alert && texts(alert)).toContain('Your change to Status was not saved.')
    // A sheet covers the table, so it takes focus even with keepFocus.
    expect(activeElement(root)?.tag).toBe('h2')
  })

  it('locks the page behind the sheet and lets it go when it closes', async () => {
    const { unmount } = mount(WithNotice, {})
    await nextTick()
    expect(overflow().style.overflow).toBe('hidden')
    unmount()
    expect(overflow().style.overflow).toBe('')
  })

  it('leaves the notice to the page once it is a pane again', async () => {
    const { root } = mount(WithNotice, {})
    await nextTick()
    narrow = false
    changed?.()
    await nextTick()
    expect(sheetNotice(root)).toHaveLength(0)
    expect(alerts(root)).toHaveLength(0)
    expect(scrollBox(root)[0]?.props['role']).toBeUndefined()
    expect(overflow().style.overflow).toBe('')
  })
})
