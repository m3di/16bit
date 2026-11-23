// @vitest-environment client-node
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findAll, fire, mount, type FakeNode } from '../../test/fake-dom.ts'
import ExternalKeyDetail from './ExternalKeyDetail.vue'

const textOf = (n: FakeNode): string =>
  n.tag === '#text' ? n.text : n.children.map(textOf).join('')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function detail(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const { root } = mount(ExternalKeyDetail, { value: 'src/app.ts' })
  const button = findAll(root, (n) => n.tag === 'button')[0] as FakeNode
  const status = findAll(root, (n) => n.props['data-copy-status'] !== undefined)[0] as FakeNode
  return { button, status }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ExternalKeyDetail', () => {
  it('copies the key and says so in a live region', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const d = detail(writeText)
    expect(d.status.props['role']).toBe('status')
    expect(textOf(d.status)).toBe('')
    fire(d.button, 'click')
    await settle()
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('src/app.ts')
    expect(textOf(d.status)).toBe('Copied')
  })

  it('says how to copy it by hand when the clipboard refuses', async () => {
    const d = detail(() => Promise.reject(new Error('NotAllowedError')))
    fire(d.button, 'click')
    await settle()
    await nextTick()
    expect(textOf(d.status)).toBe('Could not copy. Select the key and copy it yourself.')
  })
})
