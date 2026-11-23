import {
  BLOCK_TYPES,
  MAX_VIEW_BLOCKS,
  VIEW_SCHEMA_VERSION,
  checkViewTree,
  parseViewTree,
  type Attribute,
  type BlockTypeName,
  type HubDescription,
  type ViewSchemaContext,
} from '@16bit/core'
import { folderColumns } from '../hub/useHub.ts'

// The composer's draft (D76, D77): the tree as plain objects the forms change in place. It is
// checked with core's own rules on every change, so what the composer says is wrong is exactly
// what PUT would refuse.

/** A block as the composer edits it: config is whatever the forms have set so far. */
export interface DraftBlock {
  id: string
  type: BlockTypeName
  config: Record<string, unknown>
  children?: DraftBlock[]
}

/** One problem, at its path from the tree's root (`root.children.0.config.binding.folderId`). */
export interface TreeError {
  path: string
  message: string
}

export const BLOCK_LABELS: Record<BlockTypeName, string> = {
  page: 'Page',
  section: 'Section',
  columns: 'Columns',
  heading: 'Heading',
  text: 'Text',
  table: 'Table',
  list: 'List',
  board: 'Board',
  number: 'Number',
  chart: 'Chart',
  fields: 'Fields',
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const clone = <T>(value: T): T => structuredClone(value)

/** Stable JSON, keys sorted, to compare a draft block with the stored one. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}

/** The tree PUT sends. */
export const toTree = (root: DraftBlock) => ({ schemaVersion: VIEW_SCHEMA_VERSION, root })

/**
 * A draft from a view as read. A tree core reads is used with its defaults filled in; one it
 * can't (stored by a newer build) is taken as it is, block by block, so the admin can still fix
 * it; anything without a page at its root starts from an empty page.
 */
export function draftFrom(raw: unknown): DraftBlock {
  const parsed = parseViewTree(raw)
  if (parsed.ok) return clone(parsed.tree.root)
  const lenient = (b: unknown): DraftBlock | null => {
    if (!isRecord(b) || typeof b['id'] !== 'string') return null
    const type = b['type']
    if (typeof type !== 'string' || !(type in BLOCK_TYPES)) return null
    const children = Array.isArray(b['children'])
      ? b['children'].map(lenient).filter((c): c is DraftBlock => c !== null)
      : []
    return {
      id: b['id'],
      type: type as BlockTypeName,
      config: isRecord(b['config']) ? clone(b['config']) : {},
      ...(BLOCK_TYPES[type as BlockTypeName].children.length > 0 ? { children } : {}),
    }
  }
  const root = isRecord(raw) ? lenient(raw['root']) : null
  return root?.type === 'page' ? root : { id: 'page', type: 'page', config: {}, children: [] }
}

export interface Located {
  block: DraftBlock
  /** As core's paths say it: `root`, `root.children.0`, … */
  path: string
  parent: DraftBlock | null
  index: number
  depth: number
}

/** Every block, depth first, with its path. */
export function walk(root: DraftBlock): Located[] {
  const out: Located[] = []
  const visit = (
    block: DraftBlock,
    path: string,
    parent: DraftBlock | null,
    index: number,
    depth: number,
  ) => {
    out.push({ block, path, parent, index, depth })
    ;(block.children ?? []).forEach((c, i) => {
      visit(c, `${path}.children.${String(i)}`, block, i, depth + 1)
    })
  }
  visit(root, 'root', null, 0, 1)
  return out
}

export const locate = (root: DraftBlock, id: string): Located | null =>
  walk(root).find((l) => l.block.id === id) ?? null

/** Block types `parent` may hold (D14, D77). */
export const childTypes = (parent: BlockTypeName): readonly BlockTypeName[] =>
  BLOCK_TYPES[parent].children

/** A new ID unique in the tree: `list`, then `list-2`, `list-3`… */
export function newId(root: DraftBlock, type: BlockTypeName): string {
  const used = new Set(walk(root).map((l) => l.block.id))
  if (!used.has(type)) return type
  let n = 2
  while (used.has(`${type}-${String(n)}`)) n++
  return `${type}-${String(n)}`
}

/** Adds `block` as the last child of `parentId`. False when it may not hold it, or is full. */
export function addChild(root: DraftBlock, parentId: string, block: DraftBlock): boolean {
  const parent = locate(root, parentId)?.block
  if (!parent || !childTypes(parent.type).includes(block.type)) return false
  if (walk(root).length >= MAX_VIEW_BLOCKS) return false
  ;(parent.children ??= []).push(block)
  return true
}

/** Removes a block and everything in it. The page itself stays. */
export function removeBlock(root: DraftBlock, id: string): boolean {
  const at = locate(root, id)
  if (!at?.parent?.children) return false
  at.parent.children.splice(at.index, 1)
  return true
}

/** Moves a block one place up (-1) or down (1) among its siblings. */
export function moveBlock(root: DraftBlock, id: string, by: -1 | 1): boolean {
  const at = locate(root, id)
  const siblings = at?.parent?.children
  if (!at || !siblings) return false
  const to = at.index + by
  if (to < 0 || to >= siblings.length) return false
  const [moved] = siblings.splice(at.index, 1)
  if (moved) siblings.splice(to, 0, moved)
  return true
}

// ---- the hub's schema, as the forms and `checkViewTree` need it -------------------------

/** Folders of the hub (the hub root first) and the attributes each shows. */
export interface ComposerSchema {
  description: HubDescription
  /** Folders a binding may name: the hub root and every folder that holds items. */
  itemFolders: { id: string; name: string }[]
  attributesOf(folderId: string): Attribute[]
  context: ViewSchemaContext
}

export function composerSchema(description: HubDescription): ComposerSchema {
  const all = [description.hub, ...description.folders]
  const attributesOf = (folderId: string) =>
    folderColumns(description, folderId).map((c) => c.attribute)
  return {
    description,
    itemFolders: all
      .filter((f) => !f.viewsOnly)
      .map((f) => ({
        id: f.id,
        name: f.id === description.hub.id ? `${f.name} (hub root)` : f.name,
      })),
    attributesOf,
    context: {
      folders: new Map(
        all.map((f) => [f.id, { viewsOnly: f.viewsOnly === true, attributes: attributesOf(f.id) }]),
      ),
    },
  }
}

/**
 * Everything wrong with the draft, as PUT would say it: the shape and structure first
 * (`parseViewTree`), then, once that passes, the hub's schema (`checkViewTree`).
 */
export function checkDraft(root: DraftBlock, schema: ComposerSchema): TreeError[] {
  const parsed = parseViewTree(toTree(root))
  if (!parsed.ok) return parsed.errors
  return checkViewTree(parsed.tree, schema.context).map(({ path, message }) => ({ path, message }))
}

// ---- where an error shows ----------------------------------------------------------------

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}.`)

/**
 * The block an error belongs to: the deepest block whose path it starts with. `null` for the
 * whole view (the size cap, block counts at `root`, or an empty path).
 */
export function ownerOf(error: TreeError, blocks: readonly Located[]): Located | null {
  if (error.path === '' || error.path === 'root') return null
  let best: Located | null = null
  for (const l of blocks) {
    if (under(error.path, l.path) && (!best || l.path.length > best.path.length)) best = l
  }
  return best
}

/** The path inside a block's config an error is at (`binding.folderId`), or null. */
export function configPath(error: TreeError, blockPath: string): string | null {
  const prefix = `${blockPath}.config`
  if (error.path === prefix) return ''
  return error.path.startsWith(`${prefix}.`) ? error.path.slice(prefix.length + 1) : null
}

/** Whether a config path is a field's own or under it (`binding.where.and.0` is `binding.where`'s). */
export const isUnder = (path: string, field: string) =>
  field === '' ? path === '' : under(path, field)

// ---- reading and writing config by path ----------------------------------------------------

const keys = (path: string) => (path === '' ? [] : path.split('.'))

export function getAt(config: Record<string, unknown>, path: string): unknown {
  let at: unknown = config
  for (const k of keys(path)) {
    if (Array.isArray(at)) at = at[Number(k)]
    else if (isRecord(at)) at = at[k]
    else return undefined
  }
  return at
}

/** Sets a value inside config, making objects on the way. `undefined` removes the key. */
export function setAt(config: Record<string, unknown>, path: string, value: unknown) {
  const ks = keys(path)
  const last = ks.pop()
  if (last === undefined) return
  let at: Record<string, unknown> | unknown[] = config
  for (const k of ks) {
    const next: unknown = Array.isArray(at) ? at[Number(k)] : at[k]
    if (isRecord(next) || Array.isArray(next)) {
      at = next
    } else {
      const made = {}
      if (Array.isArray(at)) at[Number(k)] = made
      else at[k] = made
      at = made
    }
  }
  if (Array.isArray(at)) {
    if (value === undefined) at.splice(Number(last), 1)
    else at[Number(last)] = value
  } else if (value === undefined) {
    // Removing a key, not leaving `undefined`: strict schemas read both alike, JSON does not.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete at[last]
  } else {
    at[last] = value
  }
}
