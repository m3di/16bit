import {
  BLOCK_TYPES,
  blockDependencies,
  blockFilters,
  usesNow,
  type Block,
  type BlockStatus,
  type Change,
  type HubDescription,
} from '@16bit/core'

// When a block's data is out of date (D83): a change in its bound folder, in the folder of an
// item binding it names with `$block`, or in a relation's target hub it shows labels from; and
// at midnight in the reader's zone when it reads `$now` or today.

/** The data blocks among `blocks`, in order. */
export const dataBlocks = (blocks: readonly Block[]): Block[] =>
  blocks.filter((b) => BLOCK_TYPES[b.type].category === 'data')

const bindingFolder = (block: Block): string | null => {
  const binding = (block.config as { binding?: { folderId?: unknown } }).binding
  return typeof binding?.folderId === 'string' ? binding.folderId : null
}

/** Attribute IDs a block shows or groups by, whose relation targets it may label. */
function shownAttributes(block: Block): string[] {
  switch (block.type) {
    case 'list':
      return [
        ...block.config.fields.map((f) => f.attribute),
        ...(block.config.groupBy ? [block.config.groupBy.attribute] : []),
      ]
    case 'board':
      return block.config.fields.map((f) => f.attribute)
    case 'fields':
      return block.config.fields
    case 'chart':
      return block.config.kind === 'bars' ? [block.config.groupBy.attribute] : []
    default:
      return []
  }
}

export interface Watch {
  /** Folders whose item changes make the block stale. */
  folders: Set<string>
  /** Hubs whose item changes make the block stale: relation targets, whose labels it shows. */
  hubs: Set<string>
}

/** What each data block watches, by block ID. `blocks` is every block of the tree. */
export function watches(
  blocks: readonly Block[],
  description: HubDescription | null,
): Map<string, Watch> {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const attributes = new Map((description?.attributes ?? []).map((a) => [a.id, a]))
  const out = new Map<string, Watch>()
  for (const block of dataBlocks(blocks)) {
    const folders = new Set<string>()
    const hubs = new Set<string>()
    const own = bindingFolder(block)
    if (own) folders.add(own)
    for (const id of blockDependencies(block)) {
      const named = byId.get(id)
      const folder = named ? bindingFolder(named) : null
      if (folder) folders.add(folder)
    }
    for (const id of shownAttributes(block)) {
      const a = attributes.get(id)
      if (a?.type === 'relation') hubs.add(a.config.targetHubId)
    }
    out.set(block.id, { folders, hubs })
  }
  return out
}

/** Item IDs a block's data shows, so a move out of its folder or a delete still refetches. */
export function shownItemIds(status: BlockStatus | undefined): string[] {
  if (status?.status !== 'ok') return []
  const data = status.data
  switch (data.kind) {
    case 'items':
      return data.items.map((i) => i.id)
    case 'board':
      return data.columns.flatMap((c) => c.items.map((i) => i.id))
    case 'item':
      return data.item ? [data.item.id] : []
    default:
      return []
  }
}

/**
 * The blocks one feed change makes stale. A delete carries no item, so its folder is unknown:
 * every block refetches, since a count may have dropped.
 */
export function staleBlocks(
  change: Change,
  watched: ReadonlyMap<string, Watch>,
  shown: (blockId: string) => readonly string[],
): string[] {
  const stale: string[] = []
  for (const [id, w] of watched) {
    if (
      change.item === null ||
      w.folders.has(change.item.folderId) ||
      w.hubs.has(change.hubId) ||
      shown(id).includes(change.itemId)
    ) {
      stale.push(id)
    }
  }
  return stale
}

/** Blocks that read the date, so they move on at midnight: `$now`, a day count, a burndown. */
export function readsToday(block: Block): boolean {
  if (block.type === 'number' && block.config.kind === 'days') return true
  if (block.type === 'chart' && block.config.kind === 'burndown') return true
  return blockFilters(block).some((f) => usesNow(f.where))
}

/** The reader's time zone (D81), or `undefined` where the runtime does not say. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const DAY = 86_400_000

/**
 * Milliseconds from `now` to the next midnight in `timeZone`. A day with a clock change is an
 * hour off at most; the timer then fires late or early once, and the next is set afresh.
 */
export function msUntilMidnight(now: Date, timeZone: string | undefined): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone ?? 'UTC',
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(now)
  } catch {
    return DAY
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const elapsed =
    ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds()
  const left = DAY - elapsed
  return left > 0 ? left : DAY
}
