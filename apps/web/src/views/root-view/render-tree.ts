import {
  BLOCK_TYPES,
  MAX_VIEW_BLOCKS,
  MAX_VIEW_DEPTH,
  parseViewTree,
  type Block,
  type BlockTypeName,
  type ViewTree,
} from '@16bit/core'

// The tree as the renderer walks it. A tree `parseViewTree` reads maps one to one. A tree it
// can't read (a block type or config from a newer build, D76's upgrades going the other way) is
// read block by block instead, so one block this client doesn't know shows its own error and
// the rest of the page still renders.

export type RenderNode =
  | { kind: 'block'; block: Block; children: RenderNode[] }
  /** A block this client can't read: it shows a compact error in its place. */
  | { kind: 'broken'; id: string; children: RenderNode[] }

export interface RenderTree {
  /** The page block, with its readable config; `null` when even the root is unreadable. */
  page: Extract<RenderNode, { kind: 'block' }> | null
  /** The tree read in full, for the data request and refreshes; `null` if read block by block. */
  tree: ViewTree | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isType = (t: unknown): t is BlockTypeName => typeof t === 'string' && t in BLOCK_TYPES

function fromBlock(block: Block): RenderNode {
  return { kind: 'block', block, children: (block.children ?? []).map(fromBlock) }
}

/** One block of a tree that did not read as a whole. */
function lenient(raw: unknown, depth: number, budget: { left: number }): RenderNode | null {
  if (budget.left <= 0 || depth > MAX_VIEW_DEPTH) return null
  budget.left--
  const id =
    isRecord(raw) && typeof raw['id'] === 'string' ? raw['id'] : `block-${String(budget.left)}`
  const rawChildren = isRecord(raw) && Array.isArray(raw['children']) ? raw['children'] : []
  const children = rawChildren
    .map((c) => lenient(c, depth + 1, budget))
    .filter((c): c is RenderNode => c !== null)
  if (!isRecord(raw) || !isType(raw['type'])) return { kind: 'broken', id, children: [] }
  const type = raw['type']
  const config = BLOCK_TYPES[type].configSchema.safeParse(raw['config'] ?? {})
  if (!config.success) return { kind: 'broken', id, children: [] }
  const block = { id, type, config: config.data } as Block
  return { kind: 'block', block, children: BLOCK_TYPES[type].children.length > 0 ? children : [] }
}

export function readTree(raw: unknown): RenderTree {
  const parsed = parseViewTree(raw)
  if (parsed.ok) {
    const page = fromBlock(parsed.tree.root)
    return { page: page.kind === 'block' ? page : null, tree: parsed.tree }
  }
  const root = isRecord(raw) ? lenient(raw['root'], 1, { left: MAX_VIEW_BLOCKS }) : null
  return {
    page: root?.kind === 'block' && root.block.type === 'page' ? root : null,
    tree: null,
  }
}

/**
 * The data blocks a page can ask for: all of them when the tree read in full, else the ones
 * that read on their own. The server answers per block, so either works.
 */
export function readableBlocks(page: RenderNode | null): Block[] {
  if (!page) return []
  const out: Block[] = []
  const visit = (n: RenderNode) => {
    if (n.kind === 'block') out.push(n.block)
    n.children.forEach(visit)
  }
  visit(page)
  return out
}

/**
 * The level a `heading` block renders at. The page title is the only h1; below a titled
 * section headings go one deeper at most, so no level is skipped (`outline` is the level of
 * the nearest heading above: 1 under the page, 2 in a titled section).
 */
export function headingLevel(configured: 1 | 2 | 3, outline: number): 2 | 3 | 4 {
  return Math.min(Math.max(configured, 2), outline + 1) as 2 | 3 | 4
}

/**
 * Data blocks with headings of their own (a list's groups and a board's columns are h3). Outside
 * a titled section they get one, so their h3s never follow the page's h1 directly.
 */
export const HEADED_DATA_BLOCKS: ReadonlySet<BlockTypeName> = new Set(['list', 'board'])
