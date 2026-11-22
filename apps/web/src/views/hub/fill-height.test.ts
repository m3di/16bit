import { describe, expect, it } from 'vitest'
import { fillHeight, layoutSources, type LaidOut } from './fill-height.ts'

describe('fillHeight', () => {
  it('reaches from the top down to the bottom of the viewport, less what the page ends with', () => {
    // The hub page at 1440 by 900: the items area starts at 154 and main has 24px padding below.
    expect(fillHeight({ viewport: 900, top: 154, below: 24, min: 320 })).toBe(722)
  })

  it('never goes below the minimum, so a short window scrolls the page instead', () => {
    expect(fillHeight({ viewport: 500, top: 400, below: 24, min: 320 })).toBe(320)
  })

  it('rounds down, so a fractional top never makes the page scroll by a pixel', () => {
    expect(fillHeight({ viewport: 844, top: 402.4, below: 24, min: 320 })).toBe(417)
  })
})

type Node = LaidOut & {
  name: string
  parentElement: Node | null
  previousElementSibling: Node | null
}

/** A tree from nested arrays of names: `[name, ...children]`. */
function tree(spec: [string, ...unknown[]], parent: Node | null = null): Node[] {
  const [name, ...children] = spec
  const self: Node = { name, parentElement: parent, previousElementSibling: null }
  const all = [self]
  let previous: Node | null = null
  for (const child of children as [string, ...unknown[]][]) {
    const nodes = tree(child, self)
    const first = nodes[0] as Node
    first.previousElementSibling = previous
    previous = first
    all.push(...nodes)
  }
  return all
}

describe('layoutSources', () => {
  it('watches every ancestor and everything laid out before the element or an ancestor', () => {
    const nodes = tree([
      'body',
      ['header'],
      ['row', ['sidebar'], ['content', ['main', ['heading'], ['notice'], ['area'], ['after']]]],
    ])
    const area = nodes.find((n) => n.name === 'area') as Node
    expect(layoutSources(area).map((n) => n.name)).toEqual([
      'notice',
      'heading',
      'main',
      'content',
      'sidebar',
      'row',
      'header',
      'body',
    ])
  })
})
