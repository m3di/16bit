import {
  attributeSchema,
  indexEntries,
  type AgentHubRole,
  type Attribute,
  type FolderAttributeDefinition,
  type HubRole,
  type PaletteColor,
  type RichTextDoc,
  type RichTextListItem,
} from '@16bit/core'
import type { Kysely, Transaction } from 'kysely'
import { appendAccessLog, ensureHubAdmin, seedHubGrant } from './access-log.ts'
import { hashAgentSecret, newAgentSecret } from './auth/agent-key.ts'
import type { Database, PrincipalTable } from './db/database.ts'
import { DEV_OWNER, ensureDevAccounts, linkDevAccount, type DevPerson } from './dev-accounts.ts'
import { createItem } from './items.ts'
import { seedHubTitle } from './seed-hub-title.ts'
import { tombstoned } from './seed-tombstones.ts'

// `pnpm seed`: two demo workspaces whose hubs cover every size-meter step in docs/DESIGN.md
// (0, 1 to 9, 10 to 99, 100 to 999, 1,000 or more items), people who can sign in with the
// development password (dev-accounts.ts) in every workspace role, hub grants that exercise
// docs/ROLES.md, one agent key, and a hub (Launch) with an attribute of every M1 type.
//
// Idempotent. Everything has a fixed ID. Workspaces, principals, folders, and attributes are
// inserted with ON CONFLICT DO NOTHING. Items go through `createItem`, the API's own write path,
// so counters, `seq_id`, and `revision` stay consistent; an item whose ID already appears in
// `revision` is skipped, which also means an item deleted through the API is not brought back.
// Changing a definition here does not update rows that already exist. Exceptions: the dev
// owner is set back to `owner` if its row exists with a lower role, a seeded person's
// principal without an account (from before #51) is linked to the person's account, and a
// seeded attribute marked `indexed` here but not in the database (from before #73) is switched
// on and its item_index rows are filled from the stored values. A seeded attribute missing from
// the database (such as `launch-design`, added in #91) is inserted and added to every folder of
// its hub, after the columns already there; existing items keep their values. A seeded
// hub or attribute deleted through the API is not brought back: its ID is in `deleted_hub` or
// `deleted_attribute` (#133). New items leave a deleted attribute out, and the grants and agent
// key on a deleted hub are skipped. Grants are only added where the principal has none; the
// agent key only on the first run. Each hub's first text attribute is its title (D50), set only
// on a hub with no title at version 0, that is one nobody has edited through the API
// (seed-hub-title.ts, #120): a title a hub admin changed or cleared is never set back.

/** `indexed`: filled into item_index, so the attribute can be filtered and sorted (D6, D20). */
type AttributeSeed = Pick<Attribute, 'id' | 'name' | 'type' | 'config'> & {
  required?: boolean
  indexed?: boolean
}

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
  /** Who creates the items, round-robin. Defaults to every principal in the workspace. */
  authors?: string[]
}

/** A principal. People (`kind: 'user'`) also get an account with the development password. */
type Person = Omit<PrincipalTable, 'workspace_id' | 'account_id' | 'removed_at'> & {
  email?: string
}

interface WorkspaceSeed {
  id: string
  name: string
  /** The first is the owner, hub admin of every hub here. */
  people: [Person, ...Person[]]
  hubs: HubSeed[]
  /** Hub grants besides the owner's: principal, hub, role. */
  grants: [string, string, HubRole][]
  /** An agent principal from `people` that gets a key on its first run. */
  agentKey?: { principalId: string; hubId: string; hubRole: AgentHubRole }
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

/**
 * Title, a select, a number, a date, and a boolean: the five M0 types in every hub. Stage,
 * Points and Due are indexed, so the hub table can sort by them.
 */
function workAttributes(prefix: string): AttributeSeed[] {
  return [
    {
      id: `${prefix}-title`,
      name: 'Title',
      type: 'text',
      config: { maxLength: 200 },
      required: true,
    },
    {
      ...stage(`${prefix}-stage`, [
        ['Backlog', 'grey'],
        ['In progress', 'blue'],
        ['In review', 'violet'],
        ['Done', 'green'],
      ]),
      indexed: true,
    },
    {
      id: `${prefix}-points`,
      name: 'Points',
      type: 'number',
      config: { format: 'plain', min: 0, max: 13 },
      indexed: true,
    },
    {
      id: `${prefix}-due`,
      name: 'Due',
      type: 'date',
      config: { includeTime: false },
      indexed: true,
    },
    { id: `${prefix}-blocked`, name: 'Blocked', type: 'boolean', config: {} },
  ]
}

/**
 * Every M1 attribute type (D44), so each cell and editor has data to show. Every attribute of a
 * sortable type is indexed; actor, rich text and relation cannot be sorted and are not.
 */
function launchAttributes(): AttributeSeed[] {
  const option = (label: string, color: PaletteColor) => ({ id: slug(label), label, color })
  return [
    {
      id: 'launch-title',
      name: 'Title',
      type: 'text',
      config: { maxLength: 200 },
      required: true,
      indexed: true,
    },
    { id: 'launch-key', name: 'Key', type: 'auto_id', config: { prefix: 'LCH' }, indexed: true },
    {
      ...stage('launch-stage', [
        ['Idea', 'grey'],
        ['Planned', 'blue'],
        ['Building', 'amber'],
        ['Shipped', 'green'],
      ]),
      indexed: true,
    },
    {
      id: 'launch-tags',
      name: 'Tags',
      type: 'multi_select',
      config: {
        options: [
          option('Web', 'indigo'),
          option('API', 'teal'),
          option('Docs', 'violet'),
          option('Marketing', 'pink'),
          option('Ops', 'slate'),
        ],
      },
      indexed: true,
    },
    {
      id: 'launch-effort',
      name: 'Effort',
      type: 'number',
      config: { format: 'plain', decimals: 1, min: 0, max: 20 },
      indexed: true,
    },
    {
      id: 'launch-due',
      name: 'Due',
      type: 'date',
      config: { includeTime: false },
      indexed: true,
    },
    { id: 'launch-shipped', name: 'Shipped', type: 'boolean', config: {}, indexed: true },
    { id: 'launch-link', name: 'Link', type: 'url', config: {}, indexed: true },
    { id: 'launch-owner', name: 'Owner', type: 'actor', config: { multiple: false } },
    { id: 'launch-notes', name: 'Notes', type: 'rich_text', config: {} },
    {
      id: 'launch-depends',
      name: 'Depends on',
      type: 'relation',
      config: { targetHubId: 'launch', crossHub: false, multiple: true },
    },
    // Crosses into Design (D11), so "no access" links can be shown and tested (#91): Mina, editor
    // of Launch with no grant on Design, sees "no access"; Leo, viewer of Design, sees the item.
    // Seeded items leave it empty.
    {
      id: 'launch-design',
      name: 'Design refs',
      type: 'relation',
      config: { targetHubId: 'design', crossHub: true, multiple: true },
    },
  ]
}

const person = (id: string, name: string, workspace_role: Person['workspace_role']): Person => ({
  id,
  kind: 'user',
  name,
  workspace_role,
  email: `${id}@example.com`,
})

/**
 * People with an account, all with the development password (README.md). Every workspace role
 * in docs/ROLES.md is covered in Pixel Works: dev owner (owner), Mina (admin), Leo (member),
 * Ivy (viewer) and Noor (finance). Sam is finance in Acme Studio.
 */
export function demoSeed(): WorkspaceSeed[] {
  const owner: Person = {
    id: DEV_OWNER.id,
    kind: 'user',
    name: DEV_OWNER.name,
    workspace_role: 'owner',
    email: DEV_OWNER.email,
  }
  return [
    {
      id: 'demo',
      name: 'Pixel Works',
      people: [
        owner,
        person('mina', 'Mina Park', 'admin'),
        person('leo', 'Leo Varga', 'member'),
        { id: 'triage-bot', kind: 'agent', name: 'Triage bot', workspace_role: 'member' },
        person('ivy', 'Ivy Chen', 'viewer'),
        person('noor', 'Noor Haddad', 'finance'),
      ],
      // Mina has no grant on Design, Hiring or Archive: she sees their names as "no access"
      // (D45). Ivy's editor grant on Launch acts as viewer, capped by her role.
      grants: [
        ['mina', 'product', 'editor'],
        ['mina', 'support', 'hub_admin'],
        ['mina', 'launch', 'editor'],
        ['leo', 'product', 'editor'],
        ['leo', 'support', 'commenter'],
        ['leo', 'design', 'viewer'],
        ['leo', 'launch', 'editor'],
        ['ivy', 'product', 'viewer'],
        ['ivy', 'launch', 'editor'],
        ['noor', 'support', 'viewer'],
      ],
      agentKey: { principalId: 'triage-bot', hubId: 'product', hubRole: 'editor' },
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
        {
          id: 'launch',
          name: 'Launch',
          color: 'cyan',
          idPrefix: 'LCH',
          items: 36,
          attributes: launchAttributes(),
          // Relation targets must be readable by the writer, so only people with a grant here.
          authors: [DEV_OWNER.id, 'leo'],
          children: [{ id: 'launch-checklist', name: 'Checklist', color: 'blue' }],
        },
      ],
    },
    {
      id: 'acme',
      name: 'Acme Studio',
      people: [
        owner,
        person('sam', 'Sam Okafor', 'finance'),
        // D28: agents never manage members or billing, so no agent gets owner, admin, or finance.
        { id: 'ledger-bot', kind: 'agent', name: 'Ledger bot', workspace_role: 'member' },
      ],
      grants: [['sam', 'operations', 'viewer']],
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

/** What a value may refer to: people for actor values, earlier items for relations. */
interface ValueContext {
  people: string[]
  /** The hub's seeded item IDs in creation order. */
  itemIds: string[]
}

/** A value for item `index`, or undefined for a type the server fills in (auto_id). */
function valueFor(
  attribute: Attribute,
  index: number,
  rand: () => number,
  context: ValueContext,
): unknown {
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
    case 'multi_select': {
      const options = attribute.config.options.map((o) => o.id)
      const count = 1 + Math.floor(rand() * 3)
      return [...new Set(Array.from({ length: count }, () => pick(options)))]
    }
    case 'url':
      return `https://example.com/launch/${String(index + 1)}`
    case 'actor':
      return [pick(context.people)]
    case 'auto_id':
      return undefined
    case 'rich_text':
      return richText(`${pick(VERBS)} the ${pick(NOUNS)} before launch.`, rand() < 0.5)
    case 'relation': {
      // Earlier items only, so the target exists when this one is created.
      if (index === 0) return undefined
      const earlier = context.itemIds.slice(0, index)
      return [...new Set([pick(earlier), pick(earlier)])]
    }
  }
}

function richText(sentence: string, withList: boolean): RichTextDoc {
  const text = (value: string, bold = false) => ({
    type: 'text' as const,
    text: value,
    ...(bold ? { marks: [{ type: 'bold' as const }] } : {}),
  })
  const item = (value: string): RichTextListItem => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [text(value)] }],
  })
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [text('Goal: ', true), text(sentence)] },
      ...(withList
        ? [{ type: 'bulletList' as const, content: [item('Draft'), item('Review'), item('Ship')] }]
        : []),
    ],
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
  /** Sign-in emails of the seeded people, sorted. */
  accounts: string[]
  /** Created this run; the secret is shown once and never stored. Null if it already exists. */
  agentKey: { workspaceId: string; hubId: string; principalId: string; secret: string } | null
}

/** The seed's attributes parsed with the core contract, with the seed-only `required` flag. */
function hubDefinitions(ws: WorkspaceSeed, hub: HubSeed): FolderAttributeDefinition[] {
  return hub.attributes.map(({ required = false, indexed = false, ...a }) => ({
    attribute: attributeSchema.parse({
      ...a,
      workspaceId: ws.id,
      hubId: hub.id,
      indexed,
      version: 0,
    }),
    required,
  }))
}

export async function applySeed(db: Kysely<Database>): Promise<SeedResult> {
  const workspaces = demoSeed()
  // Parsed before any write, so a bad config in this file changes nothing in the database.
  const definitions = new Map(
    workspaces.flatMap((ws) => ws.hubs.map((hub) => [hub, hubDefinitions(ws, hub)] as const)),
  )
  const definitionsOf = (hub: HubSeed): FolderAttributeDefinition[] => definitions.get(hub) ?? []
  let itemsCreated = 0
  let agentKey: SeedResult['agentKey'] = null

  const people = new Map<string, DevPerson>()
  for (const ws of workspaces) {
    for (const p of ws.people) {
      if (p.email !== undefined) people.set(p.id, { id: p.id, name: p.name, email: p.email })
    }
  }
  const accounts = await ensureDevAccounts(db, [...people.values()])

  for (const ws of workspaces) {
    let gone = new Set<string>()
    let hubs: HubSeed[] = []
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('workspace')
        .values({ id: ws.id, name: ws.name })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
      const [devOwner, ...others] = ws.people
      // Everything here is granted by this principal, so an existing row with a lower role is
      // corrected. Every other existing principal is left as it is.
      await trx
        .insertInto('principal')
        .values({ ...principalRow(devOwner), workspace_id: ws.id })
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
          .values(others.map((p) => ({ ...principalRow(p), workspace_id: ws.id })))
          .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
          .execute()
      }
      for (const p of ws.people) {
        const accountId = accounts.get(p.id)
        if (accountId !== undefined) await linkDevAccount(trx, ws.id, p.id, accountId)
      }

      // Hubs and attributes deleted through the API stay deleted (#133). A relation into a
      // deleted hub is left out too: attribute_target_lock would refuse it.
      const goneHubs = await tombstoned(
        trx,
        'deleted_hub',
        ws.id,
        ws.hubs.map((hub) => hub.id),
      )
      hubs = ws.hubs.filter((hub) => !goneHubs.has(hub.id))
      const attributes = hubs.flatMap((hub) => definitionsOf(hub).map((d) => d.attribute))
      gone = await tombstoned(
        trx,
        'deleted_attribute',
        ws.id,
        attributes.map((a) => a.id),
      )
      for (const a of attributes) {
        if (a.type === 'relation' && goneHubs.has(a.config.targetHubId)) gone.add(a.id)
      }
      for (const hub of hubs) {
        const folders = flatten(hub, null)
        // Parents come before children, so the parent foreign key is satisfied row by row.
        const inserted = await trx
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
          .returning('id')
          .execute()
        const kept = definitionsOf(hub).filter(({ attribute }) => !gone.has(attribute.id))
        if (kept.length > 0) {
          await trx
            .insertInto('attribute')
            .values(
              kept.map(({ attribute }) => ({
                workspace_id: ws.id,
                id: attribute.id,
                hub_id: hub.id,
                name: attribute.name,
                type: attribute.type,
                config: JSON.stringify(attribute.config),
                indexed: attribute.indexed,
              })),
            )
            .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
            .execute()
          await indexSeededAttributes(trx, ws.id, hub.id, kept)
          // Every folder in a hub, the hub included, shows all of the hub's attributes.
          await trx
            .insertInto('folder_attribute')
            .values(
              folders.flatMap(({ seed }) =>
                kept.map(({ attribute, required }, position) => ({
                  workspace_id: ws.id,
                  hub_id: hub.id,
                  folder_id: seed.id,
                  attribute_id: attribute.id,
                  position,
                  required,
                })),
              ),
            )
            .onConflict((oc) =>
              oc.columns(['workspace_id', 'folder_id', 'attribute_id']).doNothing(),
            )
            .execute()
          // The hub's first text attribute is its title (D50), set only on a hub nobody has
          // edited, so a title a hub admin changed or cleared stays (#120).
          const title = kept.find(({ attribute }) => attribute.type === 'text')
          if (title) {
            const created = inserted.some((r) => r.id === hub.id)
            await seedHubTitle(trx, ws.id, hub.id, title.attribute.id, created)
          }
        }
        await ensureHubAdmin(trx, ws.id, hub.id, devOwner.id)
      }
      for (const [principalId, hubId, hubRole] of ws.grants) {
        if (goneHubs.has(hubId)) continue
        await seedHubGrant(trx, ws.id, { hubId, principalId, hubRole }, devOwner.id)
      }
      if (ws.agentKey && !goneHubs.has(ws.agentKey.hubId)) {
        const secret = await seedAgentKey(trx, ws.id, ws.agentKey, devOwner.id)
        if (secret !== null) agentKey = { workspaceId: ws.id, ...ws.agentKey, secret }
      }
    })

    for (const hub of hubs) {
      itemsCreated += await seedItems(db, ws, hub, definitionsOf(hub), gone)
    }
  }
  return {
    workspaces: workspaces.length,
    itemsCreated,
    accounts: [...people.values()].map((p) => p.email).sort(),
    agentKey,
  }
}

/** Rows read per batch when an attribute's item_index rows are filled in. */
const INDEX_BATCH = 500

/**
 * Turns on `indexed` for the seed's indexed attributes of `hub` that exist unindexed (seeded
 * before #73), and fills their item_index rows from every item's stored values, as an item
 * write would (D6). Items are locked FOR SHARE batch by batch so a concurrent write waits.
 * Attributes indexed already, or not seeded, are left alone.
 */
async function indexSeededAttributes(
  trx: Transaction<Database>,
  workspaceId: string,
  hubId: string,
  definitions: FolderAttributeDefinition[],
): Promise<void> {
  const wanted = definitions.filter((d) => d.attribute.indexed).map((d) => d.attribute)
  if (wanted.length === 0) return
  const switched = new Set(
    (
      await trx
        .updateTable('attribute')
        .set({ indexed: true })
        .where('workspace_id', '=', workspaceId)
        .where('hub_id', '=', hubId)
        .where(
          'id',
          'in',
          wanted.map((a) => a.id),
        )
        .where('indexed', '=', false)
        .returning('id')
        .execute()
    ).map((r) => r.id),
  )
  const attributes = wanted.filter((a) => switched.has(a.id))
  if (attributes.length === 0) return
  // Rows left from before the flag was switched off by hand would be stale: start clean.
  await trx
    .deleteFrom('item_index')
    .where('workspace_id', '=', workspaceId)
    .where(
      'attribute_id',
      'in',
      attributes.map((a) => a.id),
    )
    .execute()

  let after = ''
  for (;;) {
    const items = await trx
      .selectFrom('item')
      .select(['id', 'values'])
      .where('workspace_id', '=', workspaceId)
      .where('hub_id', '=', hubId)
      .where('id', '>', after)
      .orderBy('id')
      .limit(INDEX_BATCH)
      .forShare()
      .execute()
    const rows = items.flatMap((item) =>
      attributes.flatMap((attribute) =>
        indexEntries(attribute, item.values[attribute.id] ?? null).map((entry) => ({
          workspace_id: workspaceId,
          hub_id: hubId,
          attribute_id: attribute.id,
          item_id: item.id,
          ord: entry.ord,
          num: entry.column === 'num' ? (entry.value as number) : null,
          txt: entry.column === 'txt' ? (entry.value as string) : null,
          ts: entry.column === 'ts' ? (entry.value as string) : null,
        })),
      ),
    )
    if (rows.length > 0) {
      await trx.insertInto('item_index').values(rows).execute()
    }
    const last = items.at(-1)
    if (!last || items.length < INDEX_BATCH) break
    after = last.id
  }
}

const principalRow = ({ id, kind, name, workspace_role }: Person) => ({
  id,
  kind,
  name,
  workspace_role,
})

/**
 * Gives an agent principal its key and its one hub grant (D47), logged like a key made through
 * the API, and returns the secret. Null when the principal already has a key, revoked or not,
 * or holds a grant some other way, or is gone: a key is never replaced behind anyone's back.
 */
export async function seedAgentKey(
  trx: Transaction<Database>,
  workspaceId: string,
  key: { principalId: string; hubId: string; hubRole: AgentHubRole },
  createdBy: string,
): Promise<string | null> {
  const existing = await trx
    .selectFrom('agent_key')
    .select('principal_id')
    .where('workspace_id', '=', workspaceId)
    .where('principal_id', '=', key.principalId)
    .executeTakeFirst()
  if (existing) return null
  const granted = await seedHubGrant(
    trx,
    workspaceId,
    { hubId: key.hubId, principalId: key.principalId, hubRole: key.hubRole },
    createdBy,
  )
  if (!granted) return null
  const secret = newAgentSecret()
  await trx
    .insertInto('agent_key')
    .values({
      workspace_id: workspaceId,
      principal_id: key.principalId,
      secret_hash: hashAgentSecret(secret),
      created_by: createdBy,
      expires_at: null,
    })
    .execute()
  const name = await trx
    .selectFrom('principal')
    .select('name')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', key.principalId)
    .executeTakeFirstOrThrow()
  await appendAccessLog(trx, {
    workspaceId,
    actor: createdBy,
    action: 'key.create',
    target: key.principalId,
    detail: { hubId: key.hubId, hubRole: key.hubRole, name: name.name, expiresAt: null },
  })
  return secret
}

async function seedItems(
  db: Kysely<Database>,
  ws: WorkspaceSeed,
  hub: HubSeed,
  definitions: FolderAttributeDefinition[],
  gone: ReadonlySet<string>,
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

  // Relations only link items that still exist: one deleted through the API is left out.
  const live = new Set(
    (
      await db
        .selectFrom('item')
        .select('id')
        .where('workspace_id', '=', ws.id)
        .where('id', 'in', ids)
        .execute()
    ).map((r) => r.id),
  )
  const context: ValueContext = {
    people: ws.people.filter((p) => p.kind === 'user').map((p) => p.id),
    itemIds: ids,
  }
  const authors = hub.authors ?? ws.people.map((p) => p.id)

  const rand = random(hashCode(`${ws.id}/${hub.id}`))
  let created = 0
  for (const [index, id] of ids.entries()) {
    // Values are drawn for every item, skipped or not, so a partial run continues identically.
    const values: Record<string, unknown> = {}
    for (const { attribute, required } of definitions) {
      // Cross-hub relations are left empty, without a draw, so the other values stay as before.
      if (attribute.type === 'relation' && attribute.config.targetHubId !== hub.id) continue
      let value = valueFor(attribute, index, rand, context)
      if (attribute.type === 'relation' && Array.isArray(value)) {
        const targets = value.filter((target: string) => live.has(target))
        value = targets.length > 0 ? targets : undefined
      }
      if ((required || rand() < 0.85) && value !== undefined && !gone.has(attribute.id)) {
        values[attribute.id] = value
      }
    }
    if (used.has(id)) continue
    // createItem validates the values with the core contract against the stored attributes.
    // The `??` fallbacks below never apply (both arrays are non-empty and indexed modulo their
    // length); they only satisfy noUncheckedIndexedAccess.
    await createItem(db, ws.id, authors[index % authors.length] ?? ws.people[0].id, {
      id,
      folderId: folders[index % folders.length] ?? hub.id,
      values,
    })
    live.add(id)
    created++
  }
  return created
}

function hashCode(text: string): number {
  let h = 0
  for (const ch of text) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0
  return h
}
