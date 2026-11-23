import type { BlockInput, Filter, HubRole, PaletteColor } from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { ensureHubAdmin, seedHubGrant } from './access-log.ts'
import type { Database } from './db/database.ts'
import { seedAgentKey } from './demo-seed.ts'
import { DEV_OWNER, ensureDevAccounts, linkDevAccount, type DevPerson } from './dev-accounts.ts'
import { createItem } from './items.ts'
import { notifyHub } from './notify.ts'
import { lockHubSchema } from './schema-lock.ts'
import { seedHubTitle } from './seed-hub-title.ts'
import { tombstoned } from './seed-tombstones.ts'
import { validateViewTree } from './views.ts'

// The project hub (M4-06, #257): "Parcel Tracker", the hub `design/mockups/Main.dc.html` (project
// home) and `Work.dc.html` (my work) show, built from real folders, attributes, items and two
// stored root views (D76 to D83).
//
// - Folders: Home and My work (views-only; the hub opens on Home), Backlog, Sprints and Epics.
// - Backlog shows Title, Type, Stage, Owner, Reviewer, Points, Sprint, Epic, Done on, Bucket and
//   Rank, every one but Title indexed, since the views filter, sort, group or sum them. Sprints
//   show Title, Start and End (indexed: the current sprint is `start <= today <= end`); Epics
//   show Title.
// - Items: the mockups' sample data, with sprint dates relative to the seed day, so the current
//   sprint is always "day 6 of 10" on a weekday (weekdays, D81). Numbers line up with the
//   mockups: "16 of 34" points done, 2 in review or QA, 7 open bugs, Next up 19 points and Later
//   "1 not estimated", Sara with 10 open points. Where the mockups disagree with each other, the
//   data follows D82: epics read 11 of 13, 9 of 14 and 4 of 9.
// - People: Sara, Tomas, Kofi, Priya and Lena edit the hub, Ivy views it, the dev owner is hub
//   admin, and qa-agent gets an editor key whose secret `pnpm seed` writes to a gitignored file
//   for e2e (`e2e/.auth/`), never to the repository.
// - Both root views are checked by `validateViewTree`, as `PUT /view` checks them, before they
//   are stored, so the seed can't store a tree the API would refuse.
//
// Idempotent, like demo-seed.ts: fixed IDs, ON CONFLICT DO NOTHING, items through `createItem`
// and skipped once their ID is in `revision`. A view is only stored where the folder has none,
// so a view a hub admin edited is never overwritten, while one reset through the API (no row
// left) is stored again on the next run (D76 keeps no history, so nothing is lost); "Opens on"
// is set only when the hub is created. A hub deleted through the API stays deleted, and attributes
// deleted through the API are neither brought back nor filled.
//
// `applyProjectSeed(db, { tasks })` builds the same shape with generated tasks instead of the
// sample data: `pnpm seed:large --project` uses it for a 2,000-task hub (the M4-04 and M4-12
// budgets).

/** A day as `YYYY-MM-DD`, UTC. */
type Day = string

const DAY_MS = 86_400_000
const toDay = (ms: number): Day => new Date(ms).toISOString().slice(0, 10)
const isWeekend = (ms: number) => [0, 6].includes(new Date(ms).getUTCDay())

/** `ms` moved by `n` weekdays (Monday to Friday), either way. */
function addWeekdays(ms: number, n: number): number {
  let t = ms
  let left = Math.abs(n)
  while (left > 0) {
    t += Math.sign(n) * DAY_MS
    if (!isWeekend(t)) left--
  }
  return t
}

export interface SprintDates {
  number: number
  start: Day
  end: Day
}

/**
 * Sprints of 10 weekdays, the current one (`current`) placed so that `today` is its sixth day.
 * On a weekend the previous Friday counts as today. `offsets` picks sprints relative to the
 * current one (-2 is the one before last).
 */
export function sprintDates(today: Date, current: number, offsets: number[]): SprintDates[] {
  let anchor = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  while (isWeekend(anchor)) anchor -= DAY_MS
  const start = addWeekdays(anchor, -5)
  return offsets.map((offset) => {
    const s = addWeekdays(start, offset * 10)
    return { number: current + offset, start: toDay(s), end: toDay(addWeekdays(s, 9)) }
  })
}

/** A day `n` weekdays after `day`. */
const weekdaysAfter = (day: Day, n: number): Day => toDay(addWeekdays(Date.parse(day), n))

// ----------------------------------------------------------------------------------------
// Shape

export interface ProjectHubSpec {
  workspaceId: string
  workspaceName: string
  hubId: string
  name: string
  idPrefix: string
  color: PaletteColor
}

export const PARCEL_HUB: ProjectHubSpec = {
  workspaceId: 'demo',
  workspaceName: 'Pixel Works',
  hubId: 'parcel',
  name: 'Parcel Tracker',
  idPrefix: 'PT',
  color: 'orange',
}

/** The project-shaped hub `seed:large --project` fills with 2,000 tasks. */
export const SCALE_HUB: ProjectHubSpec = {
  workspaceId: 'large',
  workspaceName: 'Large folder',
  hubId: 'scale',
  name: 'Parcel Tracker at scale',
  idPrefix: 'PTS',
  color: 'amber',
}

export const PROJECT_TASKS = 2_000

/** IDs of a project hub's folders and attributes, prefixed with the hub's ID. */
export function projectIds(hubId: string) {
  const id = (name: string) => `${hubId}-${name}`
  return {
    folders: {
      home: id('home'),
      work: id('work'),
      backlog: id('backlog'),
      sprints: id('sprints'),
      epics: id('epics'),
    },
    attr: {
      title: id('title'),
      type: id('type'),
      stage: id('stage'),
      owner: id('owner'),
      reviewer: id('reviewer'),
      points: id('points'),
      sprint: id('sprint'),
      epic: id('epic'),
      doneOn: id('done-on'),
      bucket: id('bucket'),
      rank: id('rank'),
      start: id('start'),
      end: id('end'),
    },
  }
}

const option = (id: string, label: string, color: PaletteColor) => ({ id, label, color })

function attributes(hubId: string) {
  const { attr } = projectIds(hubId)
  const relation = (targetHubId: string) => ({ targetHubId, crossHub: false, multiple: false })
  return [
    { id: attr.title, name: 'Title', type: 'text', config: { maxLength: 200 }, indexed: false },
    {
      id: attr.type,
      name: 'Type',
      type: 'select',
      config: {
        options: [
          option('bug', 'Bug', 'red'),
          option('story', 'Story', 'blue'),
          option('chore', 'Chore', 'slate'),
        ],
      },
    },
    {
      id: attr.stage,
      name: 'Stage',
      type: 'select',
      config: {
        options: [
          option('to-do', 'To do', 'grey'),
          option('in-progress', 'In progress', 'blue'),
          option('in-review', 'In review', 'violet'),
          option('in-qa', 'In QA', 'amber'),
          option('done', 'Done', 'green'),
        ],
      },
    },
    { id: attr.owner, name: 'Owner', type: 'actor', config: { multiple: false } },
    { id: attr.reviewer, name: 'Reviewer', type: 'actor', config: { multiple: false } },
    {
      id: attr.points,
      name: 'Points',
      type: 'number',
      config: { format: 'plain', min: 0, max: 100 },
    },
    { id: attr.sprint, name: 'Sprint', type: 'relation', config: relation(hubId) },
    { id: attr.epic, name: 'Epic', type: 'relation', config: relation(hubId) },
    { id: attr.doneOn, name: 'Done on', type: 'date', config: { includeTime: false } },
    {
      id: attr.bucket,
      name: 'Bucket',
      type: 'select',
      config: {
        options: [option('next-up', 'Next up', 'teal'), option('later', 'Later', 'grey')],
      },
    },
    { id: attr.rank, name: 'Rank', type: 'number', config: { format: 'plain', min: 0 } },
    { id: attr.start, name: 'Start', type: 'date', config: { includeTime: false } },
    { id: attr.end, name: 'End', type: 'date', config: { includeTime: false } },
  ].map((a) => ({ indexed: true, ...a }))
}

/** The attributes each folder shows, in order. */
function folderAttributes(hubId: string): Record<string, string[]> {
  const { folders: f, attr: a } = projectIds(hubId)
  return {
    [hubId]: [a.title],
    [f.backlog]: [
      a.title,
      a.type,
      a.stage,
      a.owner,
      a.reviewer,
      a.points,
      a.sprint,
      a.epic,
      a.doneOn,
      a.bucket,
      a.rank,
    ],
    [f.sprints]: [a.title, a.start, a.end],
    [f.epics]: [a.title],
  }
}

// ----------------------------------------------------------------------------------------
// People

/** People of the project hub, after the mockups' team. All edit the hub. */
export const PROJECT_PEOPLE: DevPerson[] = [
  { id: 'sara', name: 'Sara Lind', email: 'sara@example.com' },
  { id: 'tomas', name: 'Tomas Berg', email: 'tomas@example.com' },
  { id: 'kofi', name: 'Kofi Mensah', email: 'kofi@example.com' },
  { id: 'priya', name: 'Priya Shah', email: 'priya@example.com' },
  { id: 'lena', name: 'Lena Novak', email: 'lena@example.com' },
]
/** Views the hub: the workspace viewer of demo-seed.ts. */
export const PROJECT_VIEWER = 'ivy'
/** An editor agent key, generated at seed time. */
export const PROJECT_AGENT = { id: 'qa-agent', name: 'qa-agent' } as const

// ----------------------------------------------------------------------------------------
// Items

export interface TaskSeed {
  /** Item number in the hub (`PT-214`). Ascending; the seed creates items in this order. */
  number: number
  title: string
  type: 'bug' | 'story' | 'chore'
  stage: 'to-do' | 'in-progress' | 'in-review' | 'in-qa' | 'done'
  owner?: string
  reviewer?: string
  points?: number
  /** Sprint number, or none (the backlog). */
  sprint?: number
  epic?: 'courier' | 'tracking' | 'notifications'
  /** Weekdays after the sprint's start it was done on. */
  doneDay?: number
  bucket?: 'next-up' | 'later'
  rank?: number
}

const EPICS = [
  { key: 'courier', number: 181, title: 'Courier tools' },
  { key: 'tracking', number: 182, title: 'Tracking page' },
  { key: 'notifications', number: 183, title: 'Notifications' },
] as const

/** Sprints 22 to 25, numbered 184 to 187 in the hub; 24 is the current one. */
const SPRINT_OFFSETS = [-2, -1, 0, 1]
const CURRENT_SPRINT = 24
const sprintNumber = (sprint: number) => 184 + sprint - 22

const EARLIER: [TaskSeed['epic'], string][] = [
  ['courier', 'Courier sign-in'],
  ['tracking', 'Tracking page skeleton'],
  ['courier', 'Courier route list'],
  ['tracking', 'Parcel status timeline'],
  ['notifications', 'Email on dispatch'],
  ['courier', 'Scan barcode on pickup'],
  ['tracking', 'Public tracking link'],
  ['courier', 'Offline scan queue'],
  ['notifications', 'SMS on out for delivery'],
  ['tracking', 'Map tile caching'],
  ['courier', 'Courier shift summary'],
  ['tracking', 'ETA estimate'],
  ['courier', 'Handoff signature capture'],
  ['notifications', 'Notification preferences'],
  ['tracking', 'Tracking page translations'],
  ['courier', 'Courier profile page'],
  ['tracking', 'Accessible status colours'],
  ['courier', 'Depot check-in'],
  ['notifications', 'Webhook delivery log'],
  ['tracking', 'Share tracking link'],
  ['courier', 'Failed delivery reasons'],
]
const TEAM = PROJECT_PEOPLE.map((p) => p.id)

/** The mockups' sample tasks (Main.dc.html, Work.dc.html), plus the history behind them. */
export function sampleTasks(): TaskSeed[] {
  const earlier = EARLIER.map(([epic, title], i): TaskSeed => ({
    number: 190 + i,
    title,
    type: 'story',
    stage: 'done',
    owner: TEAM[i % TEAM.length] ?? 'sara',
    points: [1, 2, 3, 5][i % 4] ?? 1,
    sprint: i < 10 ? 22 : 23,
    ...(epic && { epic }),
    doneDay: i % 10,
  }))
  const bug = (number: number, title: string, epic?: TaskSeed['epic'], points = 2): TaskSeed => ({
    number,
    title,
    type: 'bug',
    stage: 'to-do',
    points,
    sprint: 25,
    ...(epic && { epic }),
  })
  return [
    ...earlier,
    // Sprint 24 (Main.dc.html "Current work"): 34 points, 16 done.
    {
      number: 214,
      title: 'Delivery window picker',
      type: 'story',
      stage: 'in-progress',
      owner: 'sara',
      points: 5,
      sprint: 24,
      epic: 'tracking',
    },
    {
      number: 215,
      title: 'Live map on tracking page',
      type: 'story',
      stage: 'in-review',
      owner: 'tomas',
      reviewer: 'kofi',
      points: 8,
      sprint: 24,
      epic: 'tracking',
    },
    {
      number: 216,
      title: 'Review the live map PR',
      type: 'chore',
      stage: 'to-do',
      owner: 'sara',
      sprint: 24,
    },
    {
      number: 217,
      title: 'Push notification on status change',
      type: 'story',
      stage: 'in-qa',
      owner: 'sara',
      points: 5,
      sprint: 24,
      epic: 'notifications',
    },
    {
      number: 218,
      title: 'Courier handoff API',
      type: 'story',
      stage: 'done',
      owner: 'kofi',
      points: 8,
      sprint: 24,
      epic: 'courier',
      doneDay: 1,
    },
    {
      number: 219,
      title: 'Address autocomplete',
      type: 'story',
      stage: 'done',
      owner: 'priya',
      points: 5,
      sprint: 24,
      epic: 'tracking',
      doneDay: 4,
    },
    {
      number: 220,
      title: 'Fix duplicate scan events',
      type: 'bug',
      stage: 'done',
      owner: 'lena',
      points: 3,
      sprint: 24,
      epic: 'courier',
      doneDay: 2,
    },
    // Sprint 25: six of the seven open bugs.
    bug(221, 'Tracking page shows the wrong ETA', 'tracking'),
    bug(222, 'Status push sent twice', 'notifications'),
    bug(223, 'Dispatch email misses the tracking link', 'notifications', 1),
    bug(224, 'SMS opt-out ignored', 'notifications', 3),
    // Backlog (Work.dc.html): Next up 19 points, Later one not estimated.
    {
      number: 225,
      title: 'Retry failed webhooks',
      type: 'bug',
      stage: 'to-do',
      points: 3,
      epic: 'notifications',
      bucket: 'next-up',
      rank: 1,
    },
    {
      number: 226,
      title: 'Proof-of-delivery photo',
      type: 'story',
      stage: 'to-do',
      points: 8,
      epic: 'courier',
      bucket: 'next-up',
      rank: 2,
    },
    {
      number: 227,
      title: 'Dark mode for the tracking page',
      type: 'story',
      stage: 'to-do',
      points: 5,
      epic: 'tracking',
      bucket: 'next-up',
      rank: 3,
    },
    {
      number: 228,
      title: 'Rate limit the public API',
      type: 'chore',
      stage: 'to-do',
      points: 3,
      bucket: 'next-up',
      rank: 4,
    },
    bug(229, 'Label printer times out', undefined, 1),
    {
      number: 230,
      title: 'Courier ratings',
      type: 'story',
      stage: 'to-do',
      epic: 'courier',
      bucket: 'later',
      rank: 5,
    },
    {
      number: 231,
      title: 'Multi-parcel orders',
      type: 'story',
      stage: 'to-do',
      points: 13,
      epic: 'tracking',
      bucket: 'later',
      rank: 6,
    },
    bug(232, 'Courier app loses the session on rotate'),
  ]
}

/** `count` generated tasks over the same sprints, epics and people, for timing budgets. */
export function generatedTasks(count: number): TaskSeed[] {
  const stages: TaskSeed['stage'][] = ['to-do', 'in-progress', 'in-review', 'in-qa', 'done']
  const types: TaskSeed['type'][] = ['story', 'story', 'bug', 'chore']
  const epics: (TaskSeed['epic'] | undefined)[] = [
    'courier',
    'tracking',
    'notifications',
    undefined,
  ]
  return Array.from({ length: count }, (_, i): TaskSeed => {
    const sprint = [22, 23, 24, 25, undefined][i % 5]
    // Earlier sprints are done; the current one is mixed; later work is not started.
    const stage =
      sprint === undefined || sprint === 25
        ? 'to-do'
        : sprint < CURRENT_SPRINT
          ? 'done'
          : (stages[(i >> 2) % stages.length] ?? 'to-do')
    const epic = epics[i % epics.length]
    return {
      number: 1000 + i,
      title: `Task ${String(i + 1)}`,
      type: types[i % types.length] ?? 'story',
      stage,
      ...(i % 7 !== 0 && { owner: TEAM[i % TEAM.length] ?? 'sara' }),
      ...(i % 11 === 0 && { reviewer: TEAM[(i + 1) % TEAM.length] ?? 'tomas' }),
      ...(i % 9 !== 0 && { points: [1, 2, 3, 5, 8][i % 5] ?? 1 }),
      ...(sprint !== undefined && { sprint }),
      ...(epic && { epic }),
      // Done on or before the seed day (day 6, index 5) in the current sprint.
      ...(stage === 'done' && {
        doneDay: sprint === CURRENT_SPRINT ? Math.min(i % 10, 5) : i % 10,
      }),
      ...(sprint === undefined && { bucket: i % 2 ? 'later' : 'next-up', rank: i }),
    }
  })
}

// ----------------------------------------------------------------------------------------
// Root views (D76 to D79)

/** The current sprint: the Sprints item whose dates hold today (`$now`, in the reader's zone). */
function currentSprintRule(hubId: string) {
  const { folders: f, attr: a } = projectIds(hubId)
  return {
    by: 'rule' as const,
    folderId: f.sprints,
    where: {
      and: [
        { attribute: a.start, op: 'lte' as const, value: { $now: 'P0D' } },
        { attribute: a.end, op: 'gte' as const, value: { $now: 'P0D' } },
      ],
    },
    sort: [{ attribute: a.start, direction: 'desc' as const }],
  }
}

/** Project home: Main.dc.html. */
export function homeTree(hubId: string) {
  const { folders: f, attr: a } = projectIds(hubId)
  const inSprint: Filter = { attribute: a.sprint, op: 'in', value: [{ $block: 'sprint' }] }
  const backlog = (where: Filter, extra: object = {}) => ({ folderId: f.backlog, where, ...extra })
  const and = (...list: Filter[]): Filter => ({ and: list })
  const open: Filter = { attribute: a.stage, op: 'not_in', value: ['done'] }
  const blocks: BlockInput[] = [
    {
      id: 'sprint',
      type: 'fields',
      config: {
        binding: currentSprintRule(hubId),
        fields: [a.title, a.start, a.end],
        layout: 'inline',
      },
    },
    {
      id: 'stats',
      type: 'columns',
      config: {},
      children: [
        {
          id: 'sprint-day',
          type: 'number',
          config: {
            kind: 'days',
            label: 'Sprint day',
            binding: currentSprintRule(hubId),
            start: a.start,
            end: a.end,
          },
        },
        {
          id: 'points-done',
          type: 'number',
          config: {
            kind: 'aggregate',
            label: 'Points done',
            binding: backlog(inSprint),
            value: {
              fn: 'sum',
              attribute: a.points,
              where: { attribute: a.stage, op: 'eq', value: 'done' },
            },
            total: { fn: 'sum', attribute: a.points },
          },
        },
        {
          id: 'in-review',
          type: 'number',
          config: {
            kind: 'aggregate',
            label: 'In review or QA',
            binding: backlog(
              and(inSprint, { attribute: a.stage, op: 'in', value: ['in-review', 'in-qa'] }),
            ),
            value: { fn: 'count' },
          },
        },
        {
          id: 'open-bugs',
          type: 'number',
          config: {
            kind: 'aggregate',
            label: 'Open bugs',
            binding: backlog(and({ attribute: a.type, op: 'eq', value: 'bug' }, open)),
            value: { fn: 'count' },
          },
        },
      ],
    },
    {
      id: 'burndown',
      type: 'chart',
      config: {
        kind: 'burndown',
        label: 'Sprint burndown',
        binding: backlog(inSprint),
        range: { block: 'sprint', start: a.start, end: a.end },
        doneOn: a.doneOn,
        points: a.points,
      },
    },
    {
      id: 'work-and-team',
      type: 'columns',
      config: {},
      children: [
        {
          id: 'current-work',
          type: 'section',
          config: { title: 'Current work' },
          children: [
            {
              id: 'current-work-list',
              type: 'list',
              config: {
                binding: backlog(inSprint, { sort: [{ attribute: a.stage }], limit: 50 }),
                fields: [{ attribute: a.stage }, { attribute: a.owner }],
              },
            },
          ],
        },
        {
          id: 'team',
          type: 'section',
          config: { title: 'Team' },
          children: [
            {
              id: 'team-points',
              type: 'list',
              config: {
                binding: backlog(and(inSprint, open), { limit: 50 }),
                fields: [{ attribute: a.points, emptyText: '?' }],
                groupBy: { attribute: a.owner, measures: [{ fn: 'sum', attribute: a.points }] },
              },
            },
          ],
        },
      ],
    },
    {
      id: 'release',
      type: 'section',
      config: { title: 'Release 2.0' },
      children: [
        {
          id: 'epic-bars',
          type: 'chart',
          config: {
            kind: 'bars',
            label: 'Items done per epic',
            binding: { folderId: f.backlog },
            groupBy: { attribute: a.epic },
            measures: [
              { fn: 'count', where: { attribute: a.stage, op: 'eq', value: 'done' } },
              { fn: 'count' },
            ],
          },
        },
      ],
    },
  ]
  return {
    schemaVersion: 1,
    root: { id: 'page', type: 'page', config: { title: 'Parcel Tracker v2' }, children: blocks },
  }
}

/** My work: Work.dc.html. "Me" is the reader (`$me`). */
export function workTree(hubId: string) {
  const { folders: f, attr: a } = projectIds(hubId)
  const me = [{ $me: true }]
  const inSprint: Filter = { attribute: a.sprint, op: 'in', value: [{ $block: 'sprint' }] }
  const blocks: BlockInput[] = [
    { id: 'heading', type: 'heading', config: { text: 'My work', level: 1 } },
    {
      id: 'sprint',
      type: 'fields',
      config: {
        binding: currentSprintRule(hubId),
        fields: [a.title, a.start, a.end],
        layout: 'inline',
      },
    },
    {
      id: 'my-points',
      type: 'number',
      config: {
        kind: 'aggregate',
        label: 'Points open this sprint',
        binding: {
          folderId: f.backlog,
          where: {
            and: [
              inSprint,
              { attribute: a.owner, op: 'in', value: me },
              { attribute: a.stage, op: 'not_in', value: ['done'] },
            ],
          },
        },
        value: { fn: 'sum', attribute: a.points },
      },
    },
    {
      id: 'this-sprint',
      type: 'section',
      config: { title: 'This sprint' },
      children: [
        {
          id: 'my-board',
          type: 'board',
          config: {
            binding: {
              folderId: f.backlog,
              where: {
                and: [
                  inSprint,
                  {
                    or: [
                      { attribute: a.owner, op: 'in', value: me },
                      { attribute: a.reviewer, op: 'in', value: me },
                    ],
                  },
                ],
              },
            },
            column: {
              attribute: a.stage,
              options: [
                { option: 'to-do' },
                { option: 'in-progress' },
                { option: 'in-review', emptyText: 'Nothing of yours is in review.' },
                { option: 'in-qa' },
              ],
            },
            emptyText: 'Nothing here.',
            fields: [{ attribute: a.points, emptyText: '?' }],
            create: true,
          },
        },
      ],
    },
    {
      id: 'backlog',
      type: 'section',
      config: { title: 'Backlog' },
      children: [
        {
          id: 'backlog-list',
          type: 'list',
          config: {
            binding: {
              folderId: f.backlog,
              where: { attribute: a.sprint, op: 'is_empty' },
              sort: [{ attribute: a.rank }],
              limit: 100,
            },
            fields: [
              { attribute: a.type },
              { attribute: a.epic, emptyText: 'No epic' },
              { attribute: a.points, emptyText: '?' },
            ],
            groupBy: {
              attribute: a.bucket,
              measures: [
                { fn: 'sum', attribute: a.points },
                { fn: 'count_empty', attribute: a.points },
              ],
            },
            create: true,
          },
        },
      ],
    },
  ]
  return {
    schemaVersion: 1,
    root: { id: 'page', type: 'page', config: { title: 'My work' }, children: blocks },
  }
}

// ----------------------------------------------------------------------------------------
// Applying it

export interface ProjectSeedResult {
  hubDeleted: boolean
  itemsCreated: number
  /** Folders whose view was stored this run. */
  viewsStored: string[]
  /**
   * Created this run, for `seed.ts` to write to the e2e key file (or show once). Only its hash is
   * stored. Null if the key exists already.
   */
  agentKey: { workspaceId: string; hubId: string; principalId: string; secret: string } | null
  /** Sign-in emails of the project's people. */
  accounts: string[]
}

export interface ProjectSeedOptions {
  hub?: ProjectHubSpec
  /** Tasks to create; the mockups' sample data by default. */
  tasks?: TaskSeed[]
  /** The seed day. Today by default. */
  today?: Date
}

/**
 * Seeds a project hub. The workspace and the dev owner must exist (demo-seed.ts, or
 * `seedProjectWorkspace` for the large workspace). Runs as the owner of the tables.
 */
export async function applyProjectSeed(
  db: Kysely<Database>,
  options: ProjectSeedOptions = {},
): Promise<ProjectSeedResult> {
  const spec = options.hub ?? PARCEL_HUB
  const tasks = options.tasks ?? sampleTasks()
  const today = options.today ?? new Date()
  const { workspaceId: ws, hubId } = spec
  const ids = projectIds(hubId)
  const accountIds = await ensureDevAccounts(db, PROJECT_PEOPLE)
  const result: ProjectSeedResult = {
    hubDeleted: false,
    itemsCreated: 0,
    viewsStored: [],
    agentKey: null,
    accounts: PROJECT_PEOPLE.map((p) => p.email).sort(),
  }

  let gone = new Set<string>()
  await db.transaction().execute(async (trx) => {
    if ((await tombstoned(trx, 'deleted_hub', ws, [hubId])).has(hubId)) {
      result.hubDeleted = true
      return
    }
    await trx
      .insertInto('principal')
      .values([
        ...PROJECT_PEOPLE.map((p) => ({
          workspace_id: ws,
          id: p.id,
          kind: 'user' as const,
          name: p.name,
          workspace_role: 'member' as const,
        })),
        {
          workspace_id: ws,
          id: PROJECT_AGENT.id,
          kind: 'agent' as const,
          name: PROJECT_AGENT.name,
          workspace_role: 'member' as const,
        },
      ])
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .execute()
    for (const p of PROJECT_PEOPLE) {
      const accountId = accountIds.get(p.id)
      if (accountId !== undefined) await linkDevAccount(trx, ws, p.id, accountId)
    }

    const folder = (id: string, name: string, color: PaletteColor, viewsOnly = false) => ({
      workspace_id: ws,
      id,
      hub_id: hubId,
      parent_id: id === hubId ? null : hubId,
      name,
      color,
      id_prefix: spec.idPrefix,
      views_only: viewsOnly,
    })
    const createdHub = await trx
      .insertInto('folder')
      .values(folder(hubId, spec.name, spec.color))
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .returning('id')
      .execute()
    await trx
      .insertInto('folder')
      .values([
        folder(ids.folders.home, 'Home', 'orange', true),
        folder(ids.folders.work, 'My work', 'violet', true),
        folder(ids.folders.backlog, 'Backlog', 'blue'),
        folder(ids.folders.sprints, 'Sprints', 'teal'),
        folder(ids.folders.epics, 'Epics', 'pink'),
      ])
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .execute()

    const all = attributes(hubId)
    gone = await tombstoned(
      trx,
      'deleted_attribute',
      ws,
      all.map((a) => a.id),
    )
    const kept = all.filter((a) => !gone.has(a.id))
    if (kept.length > 0) {
      await trx
        .insertInto('attribute')
        .values(
          kept.map((a) => ({
            workspace_id: ws,
            id: a.id,
            hub_id: hubId,
            name: a.name,
            type: a.type as 'text',
            config: JSON.stringify(a.config),
            indexed: a.indexed,
          })),
        )
        .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
        .execute()
    }
    const rows = Object.entries(folderAttributes(hubId)).flatMap(([folderId, list]) =>
      list
        .filter((id) => !gone.has(id))
        .map((attributeId, position) => ({
          workspace_id: ws,
          hub_id: hubId,
          folder_id: folderId,
          attribute_id: attributeId,
          position,
        })),
    )
    if (rows.length > 0) {
      await trx
        .insertInto('folder_attribute')
        .values(rows)
        .onConflict((oc) => oc.columns(['workspace_id', 'folder_id', 'attribute_id']).doNothing())
        .execute()
    }
    if (!gone.has(ids.attr.title)) {
      await seedHubTitle(trx, ws, hubId, ids.attr.title, createdHub.length > 0)
    }
    // "Opens on" Home (D76), only on the run that creates the hub: a hub admin may change it.
    if (createdHub.length > 0) {
      await trx
        .updateTable('folder')
        .set({ opens_on_folder_id: ids.folders.home })
        .where('workspace_id', '=', ws)
        .where('id', '=', hubId)
        .execute()
    }

    await ensureHubAdmin(trx, ws, hubId, DEV_OWNER.id)
    const grants: [string, HubRole][] = [
      ...PROJECT_PEOPLE.map((p): [string, HubRole] => [p.id, 'editor']),
      [PROJECT_VIEWER, 'viewer'],
    ]
    for (const [principalId, hubRole] of grants) {
      const exists = await trx
        .selectFrom('principal')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('id', '=', principalId)
        .where('removed_at', 'is', null)
        .executeTakeFirst()
      if (exists) await seedHubGrant(trx, ws, { hubId, principalId, hubRole }, DEV_OWNER.id)
    }
    // Only the demo hub has a key.
    if (spec.workspaceId === PARCEL_HUB.workspaceId && spec.hubId === PARCEL_HUB.hubId) {
      const key = { principalId: PROJECT_AGENT.id, hubId, hubRole: 'editor' as const }
      const secret = await seedAgentKey(trx, ws, key, DEV_OWNER.id)
      if (secret !== null) result.agentKey = { workspaceId: ws, ...key, secret }
    }
  })
  if (result.hubDeleted) return result

  result.itemsCreated = await seedProjectItems(db, spec, tasks, today, gone)

  // Views last: their check reads the folders and attributes written above.
  for (const [folderId, tree] of [
    [ids.folders.home, homeTree(hubId)],
    [ids.folders.work, workTree(hubId)],
  ] as const) {
    if (await storeView(db, ws, hubId, folderId, tree)) result.viewsStored.push(folderId)
  }
  return result
}

/**
 * Stores `tree` as the folder's view if it has none, after the checks `PUT /view` makes. A tree
 * the hub's schema no longer accepts (an attribute deleted through the API) is skipped with a
 * warning; a tree this file got wrong fails the seed.
 */
async function storeView(
  db: Kysely<Database>,
  workspaceId: string,
  hubId: string,
  folderId: string,
  tree: unknown,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('view')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('folder_id', '=', folderId)
      .executeTakeFirst()
    if (existing) return false
    const folder = await trx
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folderId)
      .executeTakeFirst()
    if (!folder) return false
    // As PUT checks it (D79): under the hub's schema lock shared, so an attribute change made
    // meanwhile through a running API waits or is seen.
    await lockHubSchema(trx, workspaceId, hubId, 'shared')
    const checked = await validateViewTree(trx, workspaceId, hubId, tree)
    if (!checked.ok) {
      const deleted = await trx
        .selectFrom('deleted_attribute')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('hub_id', '=', hubId)
        .limit(1)
        .executeTakeFirst()
      if (deleted) {
        console.warn(`seed: view of ${folderId} not stored; the hub's attributes have changed`)
        return false
      }
      throw new Error(`seed: view of ${folderId} is invalid: ${JSON.stringify(checked.errors)}`)
    }
    const row = await trx
      .insertInto('view')
      .values({
        workspace_id: workspaceId,
        id: `${folderId}-view`,
        hub_id: hubId,
        folder_id: folderId,
        tree: JSON.stringify(checked.tree),
        updated_by: DEV_OWNER.id,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'folder_id']).doNothing())
      .returning('id')
      .execute()
    // As PUT does: open tabs of a running API reload the hub and pick the view up.
    if (row.length > 0) await notifyHub(trx, workspaceId, hubId)
    return row.length > 0
  })
}

/** Epics, sprints and tasks, in item-number order, each created once. */
async function seedProjectItems(
  db: Kysely<Database>,
  spec: ProjectHubSpec,
  tasks: TaskSeed[],
  today: Date,
  gone: ReadonlySet<string>,
): Promise<number> {
  const { workspaceId: ws, hubId } = spec
  const { folders: f, attr: a } = projectIds(hubId)
  const itemId = (n: number) => `${hubId}-${String(n)}`
  const sprints = new Map(
    sprintDates(today, CURRENT_SPRINT, SPRINT_OFFSETS).map((s) => [s.number, s]),
  )

  type Planned = {
    number: number
    folderId: string
    author: string
    values: Record<string, unknown>
  }
  const planned: Planned[] = [
    ...EPICS.map((e) => ({
      number: e.number,
      folderId: f.epics,
      author: DEV_OWNER.id,
      values: { [a.title]: e.title },
    })),
    ...[...sprints.values()].map((s) => ({
      number: sprintNumber(s.number),
      folderId: f.sprints,
      author: DEV_OWNER.id,
      values: { [a.title]: `Sprint ${String(s.number)}`, [a.start]: s.start, [a.end]: s.end },
    })),
    ...tasks.map((t) => {
      const sprint = t.sprint === undefined ? undefined : sprints.get(t.sprint)
      const epic = EPICS.find((e) => e.key === t.epic)
      const values: Record<string, unknown> = {
        [a.title]: t.title,
        [a.type]: t.type,
        [a.stage]: t.stage,
        ...(t.owner && { [a.owner]: [t.owner] }),
        ...(t.reviewer && { [a.reviewer]: [t.reviewer] }),
        ...(t.points !== undefined && { [a.points]: t.points }),
        ...(t.sprint !== undefined && { [a.sprint]: [itemId(sprintNumber(t.sprint))] }),
        ...(epic && { [a.epic]: [itemId(epic.number)] }),
        ...(sprint &&
          t.doneDay !== undefined && { [a.doneOn]: weekdaysAfter(sprint.start, t.doneDay) }),
        ...(t.bucket && { [a.bucket]: t.bucket }),
        ...(t.rank !== undefined && { [a.rank]: t.rank }),
      }
      return { number: t.number, folderId: f.backlog, author: t.owner ?? DEV_OWNER.id, values }
    }),
  ].sort((x, y) => x.number - y.number)

  const used = new Set<string>()
  const all = planned.map((p) => itemId(p.number))
  for (let i = 0; i < all.length; i += 1000) {
    const rows = await db
      .selectFrom('revision')
      .select('item_id')
      .distinct()
      .where('workspace_id', '=', ws)
      .where('item_id', 'in', all.slice(i, i + 1000))
      .execute()
    for (const r of rows) used.add(r.item_id)
  }
  // Relations name items that still exist: one deleted through the API is left out.
  const live = new Set(
    (
      await db
        .selectFrom('item')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('hub_id', '=', hubId)
        .where('folder_id', 'in', [f.sprints, f.epics])
        .execute()
    ).map((r) => r.id),
  )

  let created = 0
  for (const p of planned) {
    const id = itemId(p.number)
    if (used.has(id)) continue
    const values = Object.fromEntries(
      Object.entries(p.values).filter(([attributeId, value]) => {
        if (gone.has(attributeId)) return false
        if (attributeId === a.sprint || attributeId === a.epic) {
          return (value as string[]).every((target) => live.has(target))
        }
        return true
      }),
    )
    await db.transaction().execute(async (trx: Transaction<Database>) => {
      // The item number the mockups show (`PT-214`): numbers only ever grow, so a hub that
      // already passed it just takes the next one.
      await trx
        .updateTable('folder')
        .set({ next_seq: sql`GREATEST(next_seq, ${p.number})` })
        .where('workspace_id', '=', ws)
        .where('id', '=', hubId)
        .execute()
      await createItem(trx, ws, p.author, { id, folderId: p.folderId, values })
    })
    if (p.folderId !== f.backlog) live.add(id)
    created++
  }
  return created
}

/** The large workspace and its dev owner, for `seed:large --project` on its own. */
export async function seedProjectWorkspace(db: Kysely<Database>, spec: ProjectHubSpec) {
  const accounts = await ensureDevAccounts(db, [DEV_OWNER])
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('workspace')
      .values({ id: spec.workspaceId, name: spec.workspaceName })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await trx
      .insertInto('principal')
      .values({
        workspace_id: spec.workspaceId,
        id: DEV_OWNER.id,
        kind: 'user',
        name: DEV_OWNER.name,
        workspace_role: 'owner',
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .execute()
    const accountId = accounts.get(DEV_OWNER.id)
    if (accountId !== undefined)
      await linkDevAccount(trx, spec.workspaceId, DEV_OWNER.id, accountId)
  })
}
