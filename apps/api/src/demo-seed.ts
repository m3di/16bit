import {
  attributeSchema,
  type Attribute,
  type FolderAttributeDefinition,
  type PaletteColor,
} from '@16bit/core'
import type { Kysely } from 'kysely'
import type { Database, PrincipalTable } from './db/database.ts'
import { createItem } from './items.ts'

// `pnpm seed`: two demo workspaces whose hubs cover every size-meter step in docs/DESIGN.md
// (0, 1 to 9, 10 to 99, 100 to 999, 1,000 or more items).
//
// Idempotent. Everything has a fixed ID. Workspaces, principals, folders, and attributes are
// inserted with ON CONFLICT DO NOTHING. Items go through `createItem`, the API's own write path,
// so counters, `seq_id`, and `revision` stay consistent; an item whose ID already appears in
// `revision` is skipped, which also means an item deleted through the API is not brought back.
// Changing a definition here does not update rows that already exist. One exception: the dev
// principal is set back to `owner` if its row exists with a lower role.

type AttributeSeed = Pick<Attribute, 'id' | 'name' | 'type' | 'config'> & { required?: boolean }

interface FolderSeed {
  id: string
  name: string
  color: PaletteColor
  children?: FolderSeed[]
}

interface HubSeed extends FolderSeed {
  idPrefix: string
  /** Number of items, spread round-robin over the hub and its folders. */
  items: number
  attributes: AttributeSeed[]
}

// Seeded people have no account yet; accounts arrive with the M1 people seed (#51).
type Person = Omit<PrincipalTable, 'workspace_id' | 'account_id'>

interface WorkspaceSeed {
  id: string
  name: string
  /** The first is the owner the dev key acts as. */
  people: [Person, ...Person[]]
  hubs: HubSeed[]
}

const stage = (id: string, labels: [string, PaletteColor][]): AttributeSeed => ({
  id,
  name: 'Stage',
  type: 'select',
  config: { options: labels.map(([label, color]) => ({ id: slug(label), label, color })) },
})

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** Title, a select, a number, a date, and a boolean: the five M0 types in every hub. */
function workAttributes(prefix: string): AttributeSeed[] {
  return [
    {
      id: `${prefix}-title`,
      name: 'Title',
      type: 'text',
      config: { maxLength: 200 },
      required: true,
    },
    stage(`${prefix}-stage`, [
      ['Backlog', 'grey'],
      ['In progress', 'blue'],
      ['In review', 'violet'],
      ['Done', 'green'],
    ]),
    {
      id: `${prefix}-points`,
      name: 'Points',
      type: 'number',
      config: { format: 'plain', min: 0, max: 13 },
    },
    { id: `${prefix}-due`, name: 'Due', type: 'date', config: { includeTime: false } },
    { id: `${prefix}-blocked`, name: 'Blocked', type: 'boolean', config: {} },
  ]
}

export function demoSeed(devPrincipalId: string): WorkspaceSeed[] {
  const owner = {
    id: devPrincipalId,
    kind: 'user',
    name: 'Dev Owner',
    workspace_role: 'owner',
  } as const
  return [
    {
      id: 'demo',
      name: 'Pixel Works',
      people: [
        owner,
        { id: 'mina', kind: 'user', name: 'Mina Park', workspace_role: 'admin' },
        { id: 'leo', kind: 'user', name: 'Leo Varga', workspace_role: 'member' },
        { id: 'triage-bot', kind: 'agent', name: 'Triage bot', workspace_role: 'member' },
      ],
      hubs: [
        {
          id: 'product',
          name: 'Product',
          color: 'indigo',
          idPrefix: 'PRD',
          items: 1200,
          attributes: workAttributes('product'),
          children: [
            { id: 'product-roadmap', name: 'Roadmap', color: 'blue' },
            {
              id: 'product-bugs',
              name: 'Bugs',
              color: 'red',
              children: [{ id: 'product-triage', name: 'Triage', color: 'orange' }],
            },
          ],
        },
        {
          id: 'support',
          name: 'Support',
          color: 'teal',
          idPrefix: 'SUP',
          items: 240,
          attributes: [
            { id: 'support-title', name: 'Subject', type: 'text', config: {}, required: true },
            stage('support-stage', [
              ['New', 'amber'],
              ['Waiting', 'yellow'],
              ['Solved', 'green'],
            ]),
            {
              id: 'support-csat',
              name: 'Satisfaction',
              type: 'number',
              config: { format: 'percent', min: 0, max: 100 },
            },
            { id: 'support-opened', name: 'Opened', type: 'date', config: { includeTime: true } },
            { id: 'support-vip', name: 'VIP', type: 'boolean', config: {} },
          ],
          children: [
            { id: 'support-inbox', name: 'Inbox', color: 'cyan' },
            { id: 'support-escalated', name: 'Escalated', color: 'red' },
          ],
        },
        {
          id: 'design',
          name: 'Design',
          color: 'pink',
          idPrefix: 'DSN',
          items: 42,
          attributes: workAttributes('design'),
          children: [{ id: 'design-mockups', name: 'Mockups', color: 'magenta' }],
        },
        {
          id: 'hiring',
          name: 'Hiring',
          color: 'amber',
          idPrefix: 'HIR',
          items: 6,
          attributes: workAttributes('hiring'),
        },
        {
          id: 'archive',
          name: 'Archive',
          color: 'slate',
          idPrefix: 'ARC',
          items: 0,
          attributes: workAttributes('archive'),
        },
      ],
    },
    {
      id: 'acme',
      name: 'Acme Studio',
      people: [
        owner,
        { id: 'sam', kind: 'user', name: 'Sam Okafor', workspace_role: 'finance' },
        // D28: agents never manage members or billing, so no agent gets owner, admin, or finance.
        { id: 'ledger-bot', kind: 'agent', name: 'Ledger bot', workspace_role: 'member' },
      ],
      hubs: [
        {
          id: 'operations',
          name: 'Operations',
          color: 'green',
          idPrefix: 'OPS',
          items: 130,
          attributes: [
            {
              id: 'ops-title',
              name: 'Title',
              type: 'text',
              config: { maxLength: 200 },
              required: true,
            },
            stage('ops-stage', [
              ['Planned', 'grey'],
              ['Running', 'blue'],
              ['Done', 'green'],
            ]),
            {
              id: 'ops-cost',
              name: 'Cost',
              type: 'number',
              config: { format: 'currency', currency: 'EUR', decimals: 2, min: 0, max: 5000 },
            },
            { id: 'ops-due', name: 'Due', type: 'date', config: { includeTime: false } },
            { id: 'ops-recurring', name: 'Recurring', type: 'boolean', config: {} },
          ],
          children: [
            { id: 'ops-facilities', name: 'Facilities', color: 'lime' },
            { id: 'ops-vendors', name: 'Vendors', color: 'yellow' },
          ],
        },
        {
          id: 'sales',
          name: 'Sales',
          color: 'orange',
          idPrefix: 'SAL',
          items: 18,
          attributes: workAttributes('sales'),
          children: [{ id: 'sales-leads', name: 'Leads', color: 'amber' }],
        },
        {
          id: 'events',
          name: 'Events',
          color: 'violet',
          idPrefix: 'EVT',
          items: 3,
          attributes: workAttributes('events'),
        },
        {
          id: 'legal',
          name: 'Legal',
          color: 'ink',
          idPrefix: 'LGL',
          items: 0,
          attributes: workAttributes('legal'),
        },
      ],
    },
  ]
}

/** Small deterministic PRNG (mulberry32), so every run generates the same values. */
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
  'team offsite',
  'API limits',
]

function valueFor(attribute: Attribute, index: number, rand: () => number): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  switch (attribute.type) {
    case 'text':
      return `${pick(VERBS)} ${pick(NOUNS)} ${String(index + 1)}`
    case 'select':
      return pick(attribute.config.options).id
    case 'boolean':
      return rand() < 0.2
    case 'number': {
      const min = attribute.config.min ?? 0
      const max = attribute.config.max ?? 100
      const decimals = attribute.config.decimals ?? 0
      return Number((min + rand() * (max - min)).toFixed(decimals))
    }
    case 'date': {
      const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 365) * 86_400_000)
      if (!attribute.config.includeTime) return day.toISOString().slice(0, 10)
      day.setUTCHours(8 + Math.floor(rand() * 10), Math.floor(rand() * 60))
      return day.toISOString()
    }
    default:
      throw new Error(`The demo seed has no values for ${attribute.type} yet`)
  }
}

function flatten(
  folder: FolderSeed,
  parentId: string | null,
): { seed: FolderSeed; parentId: string | null }[] {
  return [
    { seed: folder, parentId },
    ...(folder.children ?? []).flatMap((child) => flatten(child, folder.id)),
  ]
}

export interface SeedResult {
  workspaces: number
  itemsCreated: number
}

/** The seed's attributes parsed with the core contract, with the seed-only `required` flag. */
function hubDefinitions(ws: WorkspaceSeed, hub: HubSeed): FolderAttributeDefinition[] {
  return hub.attributes.map(({ required = false, ...a }) => ({
    attribute: attributeSchema.parse({ ...a, workspaceId: ws.id, hubId: hub.id, indexed: false }),
    required,
  }))
}

export async function applySeed(
  db: Kysely<Database>,
  options: { devPrincipalId: string },
): Promise<SeedResult> {
  const workspaces = demoSeed(options.devPrincipalId)
  // Parsed before any write, so a bad config in this file changes nothing in the database.
  const definitions = new Map(
    workspaces.flatMap((ws) => ws.hubs.map((hub) => [hub, hubDefinitions(ws, hub)] as const)),
  )
  const definitionsOf = (hub: HubSeed): FolderAttributeDefinition[] => definitions.get(hub) ?? []
  let itemsCreated = 0

  for (const ws of workspaces) {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('workspace')
        .values({ id: ws.id, name: ws.name })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
      const [devOwner, ...others] = ws.people
      // The dev key relies on this principal being owner (#6), so an existing row with a lower
      // role is corrected. Every other existing principal is left as it is.
      await trx
        .insertInto('principal')
        .values({ ...devOwner, workspace_id: ws.id })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'id'])
            .doUpdateSet({ workspace_role: 'owner' })
            .where('principal.workspace_role', '<>', 'owner'),
        )
        .execute()
      if (others.length > 0) {
        await trx
          .insertInto('principal')
          .values(others.map((p) => ({ ...p, workspace_id: ws.id })))
          .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
          .execute()
      }

      for (const hub of ws.hubs) {
        const folders = flatten(hub, null)
        // Parents come before children, so the parent foreign key is satisfied row by row.
        await trx
          .insertInto('folder')
          .values(
            folders.map(({ seed, parentId }) => ({
              workspace_id: ws.id,
              id: seed.id,
              hub_id: hub.id,
              parent_id: parentId,
              name: seed.name,
              color: seed.color,
              id_prefix: hub.idPrefix,
            })),
          )
          .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
          .execute()
        await trx
          .insertInto('attribute')
          .values(
            definitionsOf(hub).map(({ attribute }) => ({
              workspace_id: ws.id,
              id: attribute.id,
              hub_id: hub.id,
              name: attribute.name,
              type: attribute.type,
              config: JSON.stringify(attribute.config),
            })),
          )
          .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
          .execute()
        // Every folder in a hub, the hub included, shows all of the hub's attributes.
        await trx
          .insertInto('folder_attribute')
          .values(
            folders.flatMap(({ seed }) =>
              definitionsOf(hub).map(({ attribute, required }, position) => ({
                workspace_id: ws.id,
                hub_id: hub.id,
                folder_id: seed.id,
                attribute_id: attribute.id,
                position,
                required,
              })),
            ),
          )
          .onConflict((oc) => oc.columns(['workspace_id', 'folder_id', 'attribute_id']).doNothing())
          .execute()
      }
    })

    for (const hub of ws.hubs) {
      itemsCreated += await seedItems(db, ws, hub, definitionsOf(hub))
    }
  }
  return { workspaces: workspaces.length, itemsCreated }
}

async function seedItems(
  db: Kysely<Database>,
  ws: WorkspaceSeed,
  hub: HubSeed,
  definitions: FolderAttributeDefinition[],
): Promise<number> {
  if (hub.items === 0) return 0
  const folders = flatten(hub, null).map(({ seed }) => seed.id)
  const ids = Array.from(
    { length: hub.items },
    (_, i) => `${hub.id}-${String(i + 1).padStart(4, '0')}`,
  )

  // Bounded by the seed definition. Checks `revision`, not `item`: IDs are never reused.
  const used = new Set(
    (
      await db
        .selectFrom('revision')
        .select('item_id')
        .distinct()
        .where('workspace_id', '=', ws.id)
        .where('item_id', 'in', ids)
        .execute()
    ).map((r) => r.item_id),
  )

  const rand = random(hashCode(`${ws.id}/${hub.id}`))
  let created = 0
  for (const [index, id] of ids.entries()) {
    // Values are drawn for every item, skipped or not, so a partial run continues identically.
    const values: Record<string, unknown> = {}
    for (const { attribute, required } of definitions) {
      const value = valueFor(attribute, index, rand)
      if (required || rand() < 0.85) values[attribute.id] = value
    }
    if (used.has(id)) continue
    // createItem validates the values with the core contract against the stored attributes.
    // The `??` fallbacks below never apply (both arrays are non-empty and indexed modulo their
    // length); they only satisfy noUncheckedIndexedAccess.
    await createItem(db, ws.id, (ws.people[index % ws.people.length] ?? ws.people[0]).id, {
      id,
      folderId: folders[index % folders.length] ?? hub.id,
      values,
    })
    created++
  }
  return created
}

function hashCode(text: string): number {
  let h = 0
  for (const ch of text) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0
  return h
}
