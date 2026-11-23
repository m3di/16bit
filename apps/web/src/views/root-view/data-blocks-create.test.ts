// @vitest-environment client-node
import { parseViewTree, type Block, type BlockInput } from '@16bit/core'
import { nextTick, type Component } from 'vue'
import { describe, expect, it } from 'vitest'
import { findAll, fire, mount, type FakeNode } from '../../test/fake-dom.ts'
import BoardBlock from './blocks/BoardBlock.vue'
import ListBlock from './blocks/ListBlock.vue'
import { task, testHost, testRouter, withHost } from './data-fixtures.test-utils.ts'
import { page } from './fixtures.test-utils.ts'
import type { BlockLoad } from './useRootView.ts'

// "New item" in a composed view, clicked in the browser build (D77): it creates in the
// binding's folder with the group's or column's value and the binding's top-level AND
// equalities preset.

function parsed(input: BlockInput): Block {
  const tree = parseViewTree(page([input]))
  if (!tree.ok) throw new Error(JSON.stringify(tree.errors))
  const block = tree.tree.root.children?.[0]
  if (!block) throw new Error('no block')
  return block
}

const textOf = (n: FakeNode): string => n.text + n.children.map(textOf).join('')

/** The "New item" button named "New item in <label>". */
function newItemIn(root: FakeNode, label: string): FakeNode {
  const button = findAll(
    root,
    (n) => n.tag === 'button' && textOf(n).replace(/\s+/g, ' ').trim() === `New item in ${label}`,
  )[0]
  if (!button) throw new Error(`no "New item in ${label}"`)
  return button
}

const items = [
  task('i1', 214, { title: 'Label printer', stage: 'done', owner: ['p-sara'] }),
  task('i2', 215, { title: 'Retry queue', stage: 'todo', owner: ['p-sara'] }),
]

async function mounted(component: Component, block: Block, load: BlockLoad) {
  const host = testHost()
  const router = testRouter()
  await router.push('/w/w/hubs/bld/home')
  const { root } = mount(withHost(component, { block, load, level: 3 }, host), {}, [router])
  await nextTick()
  return { root, host }
}

// Owner is me: a preset. "Has an epic" is not an equality, so it presets nothing.
const where = {
  and: [
    { attribute: 'owner', op: 'in', value: [{ $me: true }] },
    { attribute: 'epic', op: 'is_not_empty' },
  ],
}

describe('"New item" in a composed view', () => {
  it('under a list group creates in the binding’s folder with the group value preset', async () => {
    const block = parsed({
      id: 'mine',
      type: 'list',
      config: { binding: { folderId: 'b', where }, groupBy: { attribute: 'stage' }, create: true },
    })
    const { root, host } = await mounted(ListBlock, block, {
      state: 'ready',
      status: {
        status: 'ok',
        data: {
          kind: 'items',
          items,
          total: 2,
          groups: [
            { key: { kind: 'value', value: 'todo' }, values: [] },
            { key: { kind: 'value', value: 'done' }, values: [] },
          ],
        },
      },
    })
    fire(newItemIn(root, 'Done'), 'click')
    expect(host.created).toEqual([{ folderId: 'b', values: { owner: ['p-sara'], stage: 'done' } }])
  })

  it('in a board column creates in the binding’s folder with the column value preset', async () => {
    const block = parsed({
      id: 'work',
      type: 'board',
      config: {
        binding: { folderId: 'b', where },
        column: { attribute: 'stage', options: [{ option: 'todo' }, { option: 'done' }] },
        create: true,
      },
    })
    const { root, host } = await mounted(BoardBlock, block, {
      state: 'ready',
      status: {
        status: 'ok',
        data: {
          kind: 'board',
          columns: [
            { option: 'todo', items: items.slice(1), total: 1 },
            { option: 'done', items: [], total: 0 },
          ],
        },
      },
    })
    fire(newItemIn(root, 'To do'), 'click')
    expect(host.created).toEqual([{ folderId: 'b', values: { owner: ['p-sara'], stage: 'todo' } }])
  })
})
