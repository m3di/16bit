import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ItemValues, SelectOption, ValueError } from '@16bit/core'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from './db/database.ts'
import { ensureHubAdmin } from './access-log.ts'
import { DEV_OWNER, ensureDevAccounts, linkDevAccount } from './dev-accounts.ts'
import { HttpError } from './http.ts'
import { createItem, patchItem } from './items.ts'

// `pnpm seed:build-hub`: imports this repository's GitHub issues into a local "Build" hub,
// one item per issue. Items are written through the same path as the API (validation with
// packages/core, version check, revision append, item counts). Re-running updates in place.

export const BUILD_WORKSPACE = { id: 'team', name: '16bit.info team' } as const
export const BUILD_HUB = { id: 'build', name: 'Build', color: 'indigo', idPrefix: 'BLD' } as const
/** The importer writes as this agent, so its changes are told apart in `revision`. */
export const IMPORT_ACTOR = { id: 'github-import', name: 'GitHub import' } as const

/** Labels from docs/WORKFLOW.md. An issue's `stage:<id>` and `role:<id>` map to these. */
export const STAGE_OPTIONS: SelectOption[] = [
  { id: 'todo', label: 'To do', color: 'grey' },
  { id: 'in-progress', label: 'In progress', color: 'blue' },
  { id: 'in-review', label: 'In review', color: 'violet' },
  { id: 'in-qa', label: 'In QA', color: 'amber' },
  { id: 'done', label: 'Done', color: 'green' },
]
export const ROLE_OPTIONS: SelectOption[] = [
  { id: 'backend', label: 'Backend', color: 'teal' },
  { id: 'frontend', label: 'Frontend', color: 'cyan' },
  { id: 'design-system', label: 'Design system', color: 'pink' },
  { id: 'infra', label: 'Infra', color: 'slate' },
  { id: 'qa', label: 'QA', color: 'orange' },
  { id: 'lead', label: 'Lead', color: 'ink' },
]

/** Attribute IDs, also the keys of `item.values`. Hub-scoped, so they cannot clash (D10). */
export const ATTR = {
  title: 'title',
  issue: 'issue',
  stage: 'stage',
  role: 'role',
  milestone: 'milestone',
  url: 'url',
} as const

const ATTRIBUTES = [
  { id: ATTR.title, name: 'Title', type: 'text', config: {}, required: true },
  { id: ATTR.issue, name: 'Issue', type: 'number', config: {}, required: true },
  { id: ATTR.stage, name: 'Stage', type: 'select', config: { options: STAGE_OPTIONS } },
  { id: ATTR.role, name: 'Role', type: 'select', config: { options: ROLE_OPTIONS } },
  { id: ATTR.milestone, name: 'Milestone', type: 'text', config: {} },
  { id: ATTR.url, name: 'URL', type: 'text', config: {} },
] as const

/** The fields read from `gh issue list --json`. Extra fields are ignored. */
export const ghIssueSchema = z.object({
  number: z.int().min(1),
  title: z.string().min(1),
  state: z.enum(['OPEN', 'CLOSED']),
  url: z.url(),
  labels: z.array(z.object({ name: z.string() })),
  milestone: z.object({ title: z.string() }).nullable(),
})
export type GhIssue = z.infer<typeof ghIssueSchema>

/** Upper bound on issues read per run. Hitting it is reported, never silently truncated. */
export const ISSUE_LIMIT = 1000

/** Runs `gh issue list` and parses its output. `repo` is `owner/name`; omitted, gh uses the cwd. */
export async function fetchIssues(repo?: string): Promise<GhIssue[]> {
  const args = ['issue', 'list', '--state', 'all', '--limit', String(ISSUE_LIMIT)]
  args.push('--json', 'number,title,state,url,labels,milestone')
  if (repo) args.push('--repo', repo)
  const { stdout } = await promisify(execFile)('gh', args, { maxBuffer: 64 * 1024 * 1024 })
  return parseIssues(stdout)
}

/**
 * Parses the JSON printed by `gh issue list --json`. Throws one readable error naming the
 * first bad field, so a gh upgrade or a wrong flag fails the run before anything is written.
 */
export function parseIssues(stdout: string): GhIssue[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error('gh output is not JSON')
  }
  const result = z.array(ghIssueSchema).safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.length ? `[${issue.path.join('.')}] ` : ''
    throw new Error(`gh output is not a list of issues: ${path}${issue?.message ?? 'invalid'}`)
  }
  const seen = new Set<number>()
  for (const { number } of result.data) {
    if (seen.has(number)) throw new Error(`gh output lists issue #${String(number)} twice`)
    seen.add(number)
  }
  return result.data
}

export const itemIdFor = (issue: Pick<GhIssue, 'number'>): string => `gh-${String(issue.number)}`

function labelValue(issue: GhIssue, prefix: string, options: SelectOption[]): string | null {
  for (const { name } of issue.labels) {
    if (!name.startsWith(prefix)) continue
    const id = name.slice(prefix.length)
    if (options.some((o) => o.id === id)) return id
  }
  return null
}

/** Every attribute, with `null` for no value, so a re-run also clears what was removed on GitHub. */
export function toValues(issue: GhIssue): ItemValues {
  return {
    [ATTR.title]: issue.title,
    [ATTR.issue]: issue.number,
    // A closed issue without a stage label is done.
    [ATTR.stage]:
      labelValue(issue, 'stage:', STAGE_OPTIONS) ?? (issue.state === 'CLOSED' ? 'done' : null),
    [ATTR.role]: labelValue(issue, 'role:', ROLE_OPTIONS),
    [ATTR.milestone]: issue.milestone?.title ?? null,
    [ATTR.url]: issue.url,
  }
}

/**
 * Creates the workspace, principals, hub, and attributes if missing. Existing rows are kept,
 * except attribute names and configs, which the importer owns and brings up to date. The dev
 * owner (dev-accounts.ts) owns the workspace and can sign in to see the hub.
 */
export async function ensureBuildHub(db: Kysely<Database>): Promise<void> {
  const ws = BUILD_WORKSPACE.id
  const ownerId = DEV_OWNER.id
  const accountId = (await ensureDevAccounts(db, [DEV_OWNER])).get(ownerId)
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('workspace')
      .values({ id: ws, name: BUILD_WORKSPACE.name })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
    await trx
      .insertInto('principal')
      .values([
        { workspace_id: ws, id: ownerId, kind: 'user', name: 'Developer', workspace_role: 'owner' },
        {
          workspace_id: ws,
          id: IMPORT_ACTOR.id,
          kind: 'agent',
          name: IMPORT_ACTOR.name,
          workspace_role: 'member',
        },
      ])
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .execute()
    if (accountId !== undefined) await linkDevAccount(trx, ws, ownerId, accountId)
    await trx
      .insertInto('folder')
      .values({
        workspace_id: ws,
        id: BUILD_HUB.id,
        hub_id: BUILD_HUB.id,
        parent_id: null,
        name: BUILD_HUB.name,
        color: BUILD_HUB.color,
        id_prefix: BUILD_HUB.idPrefix,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .execute()
    await trx
      .insertInto('attribute')
      .values(
        ATTRIBUTES.map((a) => ({
          workspace_id: ws,
          id: a.id,
          hub_id: BUILD_HUB.id,
          name: a.name,
          type: a.type,
          config: JSON.stringify(a.config),
        })),
      )
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'id']).doUpdateSet({
          name: (eb) => eb.ref('excluded.name'),
          config: (eb) => eb.ref('excluded.config'),
        }),
      )
      .execute()
    await trx
      .insertInto('folder_attribute')
      .values(
        ATTRIBUTES.map((a, position) => ({
          workspace_id: ws,
          hub_id: BUILD_HUB.id,
          folder_id: BUILD_HUB.id,
          attribute_id: a.id,
          position,
          required: 'required' in a && a.required,
        })),
      )
      .onConflict((oc) => oc.columns(['workspace_id', 'folder_id', 'attribute_id']).doNothing())
      .execute()
    await ensureHubAdmin(trx, ws, BUILD_HUB.id, ownerId)
  })
}

/** An issue the hub rejected. The rest of the run carries on; the CLI exits non-zero. */
export interface ImportFailure {
  issue: number
  code: 'conflict' | 'invalid_values' | 'not_found'
  message: string
}

export interface ImportResult {
  created: number
  updated: number
  unchanged: number
  /** Issue numbers whose item was deleted locally. IDs are never reused, so they stay deleted. */
  skipped: number[]
  failed: ImportFailure[]
}

/**
 * The fields of `invalid_values` errors the importer reports. Parsed, not cast: `HttpError.extra`
 * is untyped. Typed against core's `ValueError`, so a renamed field fails the typecheck.
 */
const valueErrorsSchema = z.array(
  z.looseObject({ attributeId: z.string(), message: z.string() }),
) satisfies z.ZodType<Pick<ValueError, 'attributeId' | 'message'>[]>

/**
 * Turns a per-issue rejection into a failure entry. `perIssue` lists the codes that are about
 * this one issue on the write path that threw. Anything else (database down, missing hub) is
 * not about one issue, so it is rethrown and stops the run.
 */
function toFailure(
  issue: GhIssue,
  error: unknown,
  perIssue: readonly ImportFailure['code'][],
): ImportFailure {
  if (!(error instanceof HttpError)) throw error
  const code = perIssue.find((c) => c === error.code)
  if (!code) throw error
  if (code === 'invalid_values') {
    const parsed = valueErrorsSchema.safeParse(error.extra['errors'])
    const detail = parsed.success
      ? parsed.data.map((e) => `${e.attributeId}: ${e.message}`).join('; ')
      : ''
    return { issue: issue.number, code, message: detail || error.message }
  }
  return { issue: issue.number, code, message: error.message }
}

/** Upserts one item per issue, matched by item ID `gh-<number>`. Writes only what changed. */
export async function importIssues(
  db: Kysely<Database>,
  issues: readonly GhIssue[],
): Promise<ImportResult> {
  const ws = BUILD_WORKSPACE.id
  const result: ImportResult = { created: 0, updated: 0, unchanged: 0, skipped: [], failed: [] }

  // Oldest first, so the hub's sequence numbers (BLD-1, BLD-2, ...) follow issue order.
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const id = itemIdFor(issue)
    const values = toValues(issue)
    const current = await db
      .selectFrom('item')
      .select(['values', 'version'])
      .where('workspace_id', '=', ws)
      .where('id', '=', id)
      .executeTakeFirst()

    if (!current) {
      try {
        await createItem(db, ws, IMPORT_ACTOR.id, { id, folderId: BUILD_HUB.id, values })
        result.created++
      } catch (error) {
        if (error instanceof HttpError && error.code === 'id_taken') {
          result.skipped.push(issue.number)
        } else {
          // A missing folder here is the hub, not the issue: rethrown.
          result.failed.push(toFailure(issue, error, ['conflict', 'invalid_values']))
        }
      }
      continue
    }

    const changed = Object.fromEntries(
      Object.entries(values).filter(([key, value]) => (current.values[key] ?? null) !== value),
    )
    if (Object.keys(changed).length === 0) {
      result.unchanged++
      continue
    }
    try {
      await patchItem(db, ws, IMPORT_ACTOR.id, id, { version: current.version, values: changed })
      result.updated++
    } catch (error) {
      // conflict: someone wrote the item between our read and our write. not_found: someone
      // deleted it. Either way the next run sees the new state.
      result.failed.push(toFailure(issue, error, ['conflict', 'invalid_values', 'not_found']))
    }
  }
  return result
}

/** Hub item count, for the CLI summary. */
export async function buildHubItemCount(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('folder')
    .select('item_count')
    .where('workspace_id', '=', BUILD_WORKSPACE.id)
    .where('id', '=', BUILD_HUB.id)
    .executeTakeFirst()
  return row?.item_count ?? 0
}
