import type { Block, BlockTypeName } from '@16bit/core'
import type { Component } from 'vue'
import type { DataBlockState } from '../../ui/blocks.ts'
import type { BlockLoad } from './useRootView.ts'

// The web side of `BLOCK_TYPES` (D77): one component per block type name, as attribute types
// have theirs. A data type with no component here shows its data states only (see BlockNode).
//
// Every block component gets `block` (its config parsed by core), `load` (a data block's data,
// `undefined` for layout and content blocks) and `level`, the heading level its own headings
// start at. Layout blocks get their children in the default slot, one node per child.

export interface BlockProps {
  block: Block
  load?: BlockLoad | null
  level: number
}

const components = new Map<BlockTypeName, Component>()

export function registerBlock(type: BlockTypeName, component: Component) {
  components.set(type, component)
}

export const blockComponent = (type: BlockTypeName): Component | undefined => components.get(type)

/** A data block's state for the block components (D18, D77, D79). */
export function stateOf(load: BlockLoad | undefined): DataBlockState {
  if (!load || load.state === 'loading') return 'loading'
  if (load.state === 'failed') return 'error'
  switch (load.status.status) {
    case 'ok':
      return 'ready'
    case 'invalid':
      return 'invalid'
    case 'not_found':
      return 'not-found'
    case 'unresolved':
      return 'unresolved'
    case 'error':
      return 'error'
  }
}
