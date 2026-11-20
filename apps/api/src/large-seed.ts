import {
  attributeSchema,
  indexEntries,
  validateItemValues,
  type Attribute,
  type ItemValues,
  type PaletteColor,
  type RichTextDoc,
} from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { ensureHubAdmin } from './access-log.ts'
import type { Database } from './db/database.ts'
import { DEV_OWNER, ensureDevAccounts, linkDevAccount } from './dev-accounts.ts'
import { folderDefinitions, REVISION_CHANNEL } from './items.ts'
import { lockHubSchema } from './schema-lock.ts'
import { seedHubTitle } from './seed-hub-title.ts'
import { tombstoned } from './seed-tombstones.ts'

// `pnpm seed:large` (#173): a workspace of its own with one hub whose one folder holds 50,000
// items, for the large-folder work in M3 (D61): the virtual table, offset windows, and the EXPLAIN
// and timing checks. Its own workspace keeps 50,000 revisions out of the demo workspaces' change
// feed (D58) and their dashboards.
//
// Every M1 attribute type (D44); the sortable ones bar Done are indexed. Items are written in
// chunks, each one transaction that keeps every invariant of `createItem` (items.ts): `seq_id` and
// the item counts from the hub and folder rows, `item_index` and `link` rows, one `create`
// revision per item at version 1 with `seq` from `workspace.next_revision_seq`, and the same lock
// order (hub schema lock shared, relation targets FOR KEY SHARE, hub row, folder row, workspace
// row). Values are checked with `validateItemValues` from core against the attributes as stored,
// and `item_index` rows come from core's `indexEntries`, so nothing here re-implements a contract.
// Set-based inserts (`unnest`) instead of `createItem` per item are what keep it under a minute.
//
// Idempotent. Item IDs are fixed (`large-00001` …) and an ID that appears in `revision` is never
// written again, so a re-run only adds the items a previous run did not get to, and an item
// deleted through the API stays deleted. Item values depend only on the item's number, so an
// interrupted run continues with the same data. Values are drawn from the attributes as stored:
// an option removed through the API is not used, and an attribute deleted through the API
// (`deleted_attribute`) is neither re-created nor filled. A deleted hub (`deleted_hub`) stops the
// seed. Relations link earlier items that still exist.
//
// Each chunk sends one NOTIFY on the revision channel with its last `seq`, not one per revision.

export const LARGE_WORKSPACE = { id: 'large', name: 'Large folder' } as const
export const LARGE_HUB = {
  id: 'large',
  name: 'Large',
  color: 'violet' satisfies PaletteColor,
  idPrefix: 'LRG',
} as const
export const LARGE_FOLDER = {
  id: 'large-items',
  name: 'All items',
  color: 'blue' satisfies PaletteColor,
} as const
/** A principal for actor values besides the dev owner. It has no key and no grant. */
export const LARGE_BOT = { id: 'large-bot', name: 'Load bot' } as const

/** Items in the large folder after a complete run. */
export const LARGE_ITEMS = 50_000
/** Items per transaction. */
const CHUNK = 2_500

export const LARGE_ATTR = {
  title: 'large-title',
  key: 'large-key',
  stage: 'large-stage',
  tags: 'large-tags',
  effort: 'large-effort',
  due: 'large-due',
  done: 'large-done',
  link: 'large-link',
  owner: 'large-owner',
  notes: 'large-notes',
  depends: 'large-depends',
} as const

const option = (label: string, color: PaletteColor) => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label,
  color,
})

const ATTRIBUTES: (Pick<Attribute, 'id' | 'name' | 'type' | 'config' | 'indexed'> & {
  required: boolean
})[] = [
  {
    id: LARGE_ATTR.title,
    name: 'Title',
    type: 'text',
    config: { maxLength: 200 },
    indexed: true,
    required: true,
  },
  {
    id: LARGE_ATTR.key,
    name: 'Key',
    type: 'auto_id',
    config: { prefix: LARGE_HUB.idPrefix },
    indexed: true,
    required: false,
  },
  {
    id: LARGE_ATTR.stage,
    name: 'Stage',
    type: 'select',
    config: {
      options: [
        option('Backlog', 'grey'),
        option('Planned', 'blue'),
        option('Building', 'amber'),
        option('In review', 'violet'),
        option('Shipped', 'green'),
      ],
    },
    indexed: true,
    required: false,
  },
  {
    id: LARGE_ATTR.tags,
    name: 'Tags',
    type: 'multi_select',
    config: {
      options: [
        option('Web', 'indigo'),
        option('API', 'teal'),
        option('Docs', 'violet'),
        option('Ops', 'slate'),
        option('Data', 'pink'),
      ],
    },
    indexed: true,
    required: false,
  },
  {
    id: LARGE_ATTR.effort,
    name: 'Effort',
    type: 'number',
    config: { format: 'plain', decimals: 1, min: 0, max: 40 },
    indexed: true,
    required: false,
  },
  {
    id: LARGE_ATTR.due,
    name: 'Due',
    type: 'date',
    config: { includeTime: false },
    indexed: true,
    required: false,
  },
  {
    id: LARGE_ATTR.done,
    name: 'Done',
    type: 'boolean',
    config: {},
    indexed: false,
    required: false,
  },
  {
    id: LARGE_ATTR.link,
    name: 'Link',
    type: 'url',
    config: {},
    indexed: false,
    required: false,
  },
  {
    id: LARGE_ATTR.owner,
    name: 'Owner',
    type: 'actor',
    config: { multiple: false },
    indexed: false,
    required: false,
  },
  {
    id: LARGE_ATTR.notes,
    name: 'Notes',
    type: 'rich_text',
    config: {},
    indexed: false,
    required: false,
  },
  {
    id: LARGE_ATTR.depends,
    name: 'Depends on',
    type: 'relation',
    config: { targetHubId: LARGE_HUB.id, crossHub: false, multiple: true },
    indexed: false,
    required: false,
  },
]

/** `large-00001` for item number 1. */
export const largeItemId = (n: number): string => `large-${String(n).padStart(5, '0')}`

export interface LargeSeedOptions {
  /** Defaults to `LARGE_ITEMS`; tests use fewer. */
  items?: number
  /** Items per transaction. Defaults to 2,500. */
  chunk?: number
}

export interface LargeSeedResult {
  hubDeleted: boolean
  created: number
  /** Items in the large folder after the run. */
  folderItems: number
}

export async function applyLargeSeed(
  db: Kysely<Database>,
  options: LargeSeedOptions = {},
): Promise<LargeSeedResult> {
  const total = options.items ?? LARGE_ITEMS
  const chunk = options.chunk ?? CHUNK
  if (!Number.isInteger(total) || total < 0 || total > 99_999) {
    throw new Error('seed:large: items must be an integer from 0 to 99,999')
  }
  if (!Number.isInteger(chunk) || chunk < 1) {
    throw new Error('seed:large: chunk must be a positive integer')
  }
  const { hubDeleted } = await ensureLargeHub(db)
  if (hubDeleted) return { hubDeleted, created: 0, folderItems: 0 }
  let created = 0
  for (let first = 1; first <= total; first += chunk) {
    const last = Math.min(total, first + chunk - 1)
    created += await db.transaction().execute((trx) => seedChunk(trx, first, last))
  }
  const folder = await db
    .selectFrom('folder')
    .select('item_count')
    .where('workspace_id', '=', LARGE_WORKSPACE.id)
    .where('id', '=', LARGE_FOLDER.id)
    .executeTakeFirst()
  return { hubDeleted: false, created, folderItems: folder?.item_count ?? 0 }
}

/**
 * The workspace, its owner (the dev owner's account) and the Load bot, the hub with its folder
 * and attributes, the title attribute (D50) and the owner's hub admin grant. Inserts only what
 * is missing. Returns `hubDeleted` when the hub was deleted through the API.
 */
export async function ensureLargeHub(db: Kysely<Database>): Promise<{ hubDeleted: boolean }> {
  const ws = LARGE_WORKSPACE.id
  // Parsed before any write, so a bad definition here changes nothing in the database.
  const parsed = ATTRIBUTES.map(({ required, ...a }) => ({
    attribute: attributeSchema.parse({ ...a, workspaceId: ws, hubId: LARGE_HUB.id, version: 0 }),
    required,
  }))
  const accountId = (await ensureDevAccounts(db, [DEV_OWNER])).get(DEV_OWNER.id)
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto('workspace')
      .values({ id: ws, name: LARGE_WORKSPACE.name })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await trx
      .insertInto('principal')
      .values([
        {
          workspace_id: ws,
          id: DEV_OWNER.id,
          kind: 'user',
          name: DEV_OWNER.name,
          workspace_role: 'owner',
        },
        {
          workspace_id: ws,
          id: LARGE_BOT.id,
          kind: 'agent',
          name: LARGE_BOT.name,
          workspace_role: 'member',
        },
      ])
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .execute()
    if (accountId !== undefined) await linkDevAccount(trx, ws, DEV_OWNER.id, accountId)
    if ((await tombstoned(trx, 'deleted_hub', ws, [LARGE_HUB.id])).size > 0) {
      return { hubDeleted: true }
    }
    const inserted = await trx
      .insertInto('folder')
      .values([
        {
          workspace_id: ws,
          id: LARGE_HUB.id,
          hub_id: LARGE_HUB.id,
          parent_id: null,
          name: LARGE_HUB.name,
          color: LARGE_HUB.color,
          id_prefix: LARGE_HUB.idPrefix,
        },
        {
          workspace_id: ws,
          id: LARGE_FOLDER.id,
          hub_id: LARGE_HUB.id,
          parent_id: LARGE_HUB.id,
          name: LARGE_FOLDER.name,
          color: LARGE_FOLDER.color,
          id_prefix: LARGE_HUB.idPrefix,
        },
      ])
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .returning('id')
      .execute()
    const gone = await tombstoned(
      trx,
      'deleted_attribute',
      ws,
      parsed.map((d) => d.attribute.id),
    )
    const kept = parsed.filter((d) => !gone.has(d.attribute.id))
    if (kept.length > 0) {
      await trx
        .insertInto('attribute')
        .values(
          kept.map(({ attribute }) => ({
            workspace_id: ws,
            id: attribute.id,
            hub_id: LARGE_HUB.id,
            name: attribute.name,
            type: attribute.type,
            config: JSON.stringify(attribute.config),
            indexed: attribute.indexed,
          })),
        )
        .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
        .execute()
      // A folder whose row exists already keeps its columns as a hub admin left them.
      const fresh = [LARGE_HUB.id, LARGE_FOLDER.id].filter((id) =>
        inserted.some((r) => r.id === id),
      )
      if (fresh.length > 0) {
        await trx
          .insertInto('folder_attribute')
          .values(
            fresh.flatMap((folderId) =>
              kept.map(({ attribute, required }, position) => ({
                workspace_id: ws,
                hub_id: LARGE_HUB.id,
                folder_id: folderId,
                attribute_id: attribute.id,
                position,
                required,
              })),
            ),
          )
          .onConflict((oc) => oc.columns(['workspace_id', 'folder_id', 'attribute_id']).doNothing())
          .execute()
      }
      const created = inserted.some((r) => r.id === LARGE_HUB.id)
      await seedHubTitle(trx, ws, LARGE_HUB.id, LARGE_ATTR.title, created)
    }
    await ensureHubAdmin(trx, ws, LARGE_HUB.id, DEV_OWNER.id)
    return { hubDeleted: false }
  })
}

/** Small deterministic PRNG (mulberry32), seeded per item so values depend only on its number. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VERBS = [
  'Fix',
  'Add',
  'Review',
  'Update',
  'Plan',
  'Draft',
  'Check',
  'Remove',
  'Design',
  'Test',
]
const NOUNS = [
  'login flow',
  'invoice export',
  'onboarding email',
  'pixel avatars',
  'search results',
  'billing page',
  'release notes',
  'size meter',
  'dark theme',
  'vendor contract',
  'scroll window',
  'API limits',
]
const ACTORS = [DEV_OWNER.id, LARGE_BOT.id]

function notes(sentence: string): RichTextDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Note: ', marks: [{ type: 'bold' }] },
          { type: 'text', text: sentence },
        ],
      },
    ],
  }
}

/**
 * Values for item number `n`, drawn from the attributes as stored. Relation candidates are
 * earlier item numbers; the caller drops those that no longer exist. Auto IDs are left to the
 * write, like `createItem` does.
 */
function valuesFor(
  n: number,
  attributes: readonly Attribute[],
): { values: Record<string, unknown>; targets: number[] } {
  const rand = random(Math.imul(n, 0x9e3779b1))
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const values: Record<string, unknown> = {}
  let targets: number[] = []
  // Always drawn, in a fixed order, so a removed attribute leaves the others as they were.
  const title = `${pick(VERBS)} ${pick(NOUNS)} ${String(n)}`
  const filled = () => rand() < 0.85
  for (const attribute of attributes) {
    switch (attribute.type) {
      case 'text':
        values[attribute.id] = title
        break
      case 'select': {
        const options = attribute.config.options
        if (filled() && options.length > 0) values[attribute.id] = pick(options).id
        break
      }
      case 'multi_select': {
        const options = attribute.config.options.map((o) => o.id)
        if (filled() && options.length > 0) {
          const count = 1 + Math.floor(rand() * 3)
          values[attribute.id] = [...new Set(Array.from({ length: count }, () => pick(options)))]
        }
        break
      }
      case 'number': {
        const min = attribute.config.min ?? 0
        const max = attribute.config.max ?? 100
        const decimals = attribute.config.decimals ?? 0
        if (filled()) values[attribute.id] = Number((min + rand() * (max - min)).toFixed(decimals))
        break
      }
      case 'date': {
        const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 730) * 86_400_000)
        if (filled()) {
          if (attribute.config.includeTime) {
            day.setUTCHours(8 + Math.floor(rand() * 10), Math.floor(rand() * 60))
            values[attribute.id] = day.toISOString()
          } else {
            values[attribute.id] = day.toISOString().slice(0, 10)
          }
        }
        break
      }
      case 'boolean':
        values[attribute.id] = rand() < 0.3
        break
      case 'url':
        if (filled()) values[attribute.id] = `https://example.com/large/${String(n)}`
        break
      case 'actor':
        if (filled()) values[attribute.id] = [pick(ACTORS)]
        break
      case 'rich_text':
        // One in ten, so the folder stays light enough to page through quickly.
        if (rand() < 0.1) values[attribute.id] = notes(`${pick(VERBS)} the ${pick(NOUNS)}.`)
        break
      case 'relation':
        // The previous item and one of the 50 before it. Same-hub relations only.
        if (n > 1 && attribute.config.targetHubId === LARGE_HUB.id && rand() < 0.5) {
          targets = [...new Set([n - 1, Math.max(1, n - 1 - Math.floor(rand() * 50))])]
          values[attribute.id] = targets.map(largeItemId)
        }
        break
      case 'auto_id':
        break
    }
  }
  return { values, targets }
}

/** Writes items `first` to `last` that were never written, in one transaction. */
async function seedChunk(trx: Transaction<Database>, first: number, last: number): Promise<number> {
  const ws = LARGE_WORKSPACE.id
  const hubId = LARGE_HUB.id
  const folderId = LARGE_FOLDER.id
  const actor = DEV_OWNER.id
  const numbers = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const ids = numbers.map(largeItemId)

  // As createItem: before reading the attributes, so a schema write that strips values waits.
  await lockHubSchema(trx, ws, hubId, 'shared')
  const definitions = await folderDefinitions(trx, ws, folderId)
  if (definitions.length === 0) {
    const folder = await trx
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('id', '=', folderId)
      .executeTakeFirst()
    if (!folder) throw new Error(`seed:large: folder ${folderId} is gone`)
  }
  const attributes = definitions.map((d) => d.attribute)
  const relationIds = new Set(attributes.filter((a) => a.type === 'relation').map((a) => a.id))

  // Checks `revision`, not `item`: IDs are never reused, so a deleted item stays deleted.
  const used = new Set(
    (
      await trx
        .selectFrom('revision')
        .select('item_id')
        .distinct()
        .where('workspace_id', '=', ws)
        .where('item_id', 'in', ids)
        .execute()
    ).map((r) => r.item_id),
  )
  const todo = numbers.filter((n) => !used.has(largeItemId(n)))
  if (todo.length === 0) return 0

  const drafts = todo.map((n) => ({ n, ...valuesFor(n, attributes) }))
  // Earlier items this chunk links to, locked FOR KEY SHARE in ID order before the hub row (the
  // lock order in items.ts), so none can be deleted before the links commit.
  const inChunk = new Set(todo)
  const outside = [
    ...new Set(drafts.flatMap((d) => d.targets.filter((t) => !inChunk.has(t)).map(largeItemId))),
  ].sort()
  const live = new Set<string>()
  if (outside.length > 0) {
    const rows = await sql<{ id: string }>`
      SELECT id FROM item
      WHERE workspace_id = ${ws} AND hub_id = ${hubId} AND id = ANY(${outside}::text[])
      ORDER BY id
      FOR KEY SHARE
    `.execute(trx)
    for (const r of rows.rows) live.add(r.id)
  }
  for (const n of todo) live.add(largeItemId(n))

  const valid = drafts.map(({ n, values }) => {
    for (const id of relationIds) {
      const value = values[id]
      if (!Array.isArray(value)) continue
      const kept = (value as string[]).filter((t) => live.has(t))
      // Empty is null, which the contract normalises and the strip below drops.
      values[id] = kept.length > 0 ? kept : null
    }
    const result = validateItemValues(definitions, values, { partial: false })
    if (!result.ok) {
      throw new Error(
        `seed:large: item ${largeItemId(n)} is not valid: ${JSON.stringify(result.errors)}`,
      )
    }
    return {
      n,
      values: Object.fromEntries(Object.entries(result.values).filter(([, v]) => v !== null)),
    }
  })

  const k = valid.length
  // Hub row: item numbers and the hub's count in one statement. Then the folder row.
  const hub = await trx
    .updateTable('folder')
    .set({ next_seq: sql`next_seq + ${k}`, item_count: sql`item_count + ${k}` })
    .where('workspace_id', '=', ws)
    .where('id', '=', hubId)
    .returning(sql<number>`next_seq - ${k}`.as('first'))
    .executeTakeFirstOrThrow()
  await trx
    .updateTable('folder')
    .set({ item_count: sql`item_count + ${k}` })
    .where('workspace_id', '=', ws)
    .where('id', '=', folderId)
    .execute()

  const autoIds = attributes.filter((a) => a.type === 'auto_id')
  const items = valid.map(({ n, values }, i) => {
    const seqId = hub.first + i
    const stored: ItemValues = { ...values }
    for (const a of autoIds) stored[a.id] = seqId
    return { id: largeItemId(n), seqId, values: stored }
  })

  await sql`
    INSERT INTO item (workspace_id, id, hub_id, folder_id, seq_id, values, updated_by)
    SELECT ${ws}, id, ${hubId}, ${folderId}, seq_id, values::jsonb, ${actor}
    FROM unnest(${items.map((i) => i.id)}::text[], ${items.map((i) => i.seqId)}::bigint[],
                ${items.map((i) => JSON.stringify(i.values))}::text[]) AS t(id, seq_id, values)
  `.execute(trx)

  const index = items.flatMap((item) =>
    definitions
      .filter((d) => d.attribute.indexed)
      .flatMap(({ attribute }) =>
        indexEntries(attribute, item.values[attribute.id] ?? null).map((e) => ({
          item: item.id,
          attribute: attribute.id,
          ord: e.ord,
          num: e.column === 'num' ? (e.value as number) : null,
          txt: e.column === 'txt' ? (e.value as string) : null,
          ts: e.column === 'ts' ? (e.value as string) : null,
        })),
      ),
  )
  if (index.length > 0) {
    await sql`
      INSERT INTO item_index (workspace_id, attribute_id, item_id, ord, num, txt, ts)
      SELECT ${ws}, attribute_id, item_id, ord, num, txt, ts
      FROM unnest(${index.map((r) => r.attribute)}::text[], ${index.map((r) => r.item)}::text[],
                  ${index.map((r) => r.ord)}::smallint[], ${index.map((r) => r.num)}::float8[],
                  ${index.map((r) => r.txt)}::text[], ${index.map((r) => r.ts)}::timestamptz[])
        AS t(attribute_id, item_id, ord, num, txt, ts)
    `.execute(trx)
  }

  const links = items.flatMap((item) =>
    [...relationIds].flatMap((attribute) => {
      const value = item.values[attribute]
      return Array.isArray(value) ? value.map((to) => ({ from: item.id, attribute, to })) : []
    }),
  )
  if (links.length > 0) {
    await sql`
      INSERT INTO link (workspace_id, from_item, attribute_id, to_item)
      SELECT ${ws}, from_item, attribute_id, to_item
      FROM unnest(${links.map((l) => l.from)}::text[], ${links.map((l) => l.attribute)}::text[],
                  ${links.map((l) => l.to)}::text[]) AS t(from_item, attribute_id, to_item)
    `.execute(trx)
  }

  // Workspace row last. The seed runs as the table owner, which workspace_guard skips, so one
  // UPDATE takes all k numbers (appendRevisions in items.ts does the same outside a request).
  const { next } = await trx
    .updateTable('workspace')
    .set({ next_revision_seq: sql`next_revision_seq + ${k}` })
    .where('id', '=', ws)
    .returning('next_revision_seq as next')
    .executeTakeFirstOrThrow()
  const firstSeq = next - k
  await sql`
    INSERT INTO revision (workspace_id, seq, item_id, hub_id, version, patch, actor)
    SELECT ${ws}, seq, item_id, ${hubId}, 1, patch::jsonb, ${actor}
    FROM unnest(${items.map((_, i) => firstSeq + i)}::bigint[], ${items.map((i) => i.id)}::text[],
                ${items.map((i) => JSON.stringify({ op: 'create', folderId, values: i.values }))}::text[])
      AS t(seq, item_id, patch)
  `.execute(trx)
  await sql`SELECT pg_notify(${REVISION_CHANNEL}, ${`${ws}:${String(next - 1)}`})`.execute(trx)
  return k
}
