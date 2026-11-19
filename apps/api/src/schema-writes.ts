import { randomUUID } from 'node:crypto'
import {
  applyAttributeUpdate,
  attributeSchema,
  can,
  indexEntries,
  type Attribute,
  type CreateAttribute,
  type CreateFolder,
  type DeleteAttributeQuery,
  type Folder,
  type FolderAttributesResult,
  type Hub,
  type HubGrantEntry,
  type ItemValues,
  type Page,
  type PageQuery,
  type SetFolderAttributes,
  type Subject,
  type UpdateAttribute,
  type UpdateFolder,
  type UpdateHub,
} from '@16bit/core'
import { sql, type RawBuilder, type Transaction } from 'kysely'
import { z } from 'zod'
import { hubExists, ownGrant } from './access.ts'
import type { Database } from './db/database.ts'
import {
  decodeCursor,
  encodeCursor,
  enforce,
  HttpError,
  notFound,
  schemaConflict,
  sqlState,
} from './http.ts'
import { appendRevisions } from './items.ts'
import { toAttribute, toFolder, toFolderAttribute, toHub } from './mappers.ts'
import { lockHubSchema } from './schema-lock.ts'

// Schema writes for hub settings (#112): the hub itself, its folders and attributes, which
// attributes each folder shows, hub deletion and the grant list (contracts in
// packages/core/src/hub-settings.ts, rules in docs/ROLES.md, D50 to D52). Each route decides
// with `can()` and runs in the request's scoped transaction (row-level security, migration 0009,
// checks the same rules again underneath).
//
// Lock order, next to item writes (items.ts) and access changes (members.ts), so that none of
// them can deadlock with another:
//
//   1. the caller's own grant on the hub FOR SHARE (a cross-hub relation also locks the caller's
//      grant on the target hub here, before the insert: delete_hub(target) holds the target's
//      grants while it waits for the hub row that attribute_target_lock takes);
//   2. removing an option or an attribute: the hub's schema lock, exclusive (schema-lock.ts).
//      Item creates and patches take it shared before they read the attributes;
//   3. attribute rows: the one being changed, or the ones a folder will show (FOR KEY SHARE);
//   4. item rows whose values are stripped, in ID order. Item deletes take their item row, then
//      the hub row, so items always come before the hub row;
//   5. the hub row FOR NO KEY UPDATE (moving, creating or deleting a folder; changing the hub;
//      clearing a deleted title attribute). Item creates take the hub row and then the folder
//      row, so a folder delete checks for items while it holds the hub row and never waits on
//      an item row;
//   6. folder rows, in ID order, then folder_attribute rows;
//   7. the workspace row, taken by the revisions of stripped items, last.
//
// Hub deletion is delete_hub() (migration 0009), which takes the hub's grants FOR UPDATE before
// anything else, so every writer above, holding its grant FOR SHARE, finishes first or waits
// and then finds no hub.

type Trx = Transaction<Database>

const forbidden = () => new HttpError('forbidden', 'Your role does not allow this action')
const invalid = (message: string) => new HttpError('invalid_request', message)

/**
 * Enforces `hub.manageSchema` and holds the caller's grant FOR SHARE until commit (step 1), so a
 * revoke waits for the write. `what` names the thing a 404 hides.
 */
async function requireManage(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  hubId: string,
  what: string,
): Promise<void> {
  const hubGrant = await ownGrant(trx, workspaceId, hubId, me.id, 'share')
  enforce(can(me, 'hub.manageSchema', { hubGrant }), what)
}

/** 404 unless `hubId` is a hub the caller can see (owners and admins see every hub row). */
async function requireHub(trx: Trx, workspaceId: string, hubId: string): Promise<void> {
  if (!(await hubExists(trx, workspaceId, hubId))) throw notFound('Hub')
}

/** The hub row FOR NO KEY UPDATE (step 5), or 404. */
async function lockHubRow(trx: Trx, workspaceId: string, hubId: string) {
  const row = await trx
    .selectFrom('folder')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', hubId)
    .where('parent_id', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('Hub')
  return row
}

/** A folder's hub, or 404 when it is missing or hidden. */
async function hubOfFolder(trx: Trx, workspaceId: string, folderId: string): Promise<string> {
  const row = await trx
    .selectFrom('folder')
    .select('hub_id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', folderId)
    .executeTakeFirst()
  if (!row) throw notFound('Folder')
  return row.hub_id
}

/** An attribute's hub, or 404 when it is missing or hidden. */
async function hubOfAttribute(trx: Trx, workspaceId: string, attributeId: string) {
  const row = await trx
    .selectFrom('attribute')
    .select('hub_id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', attributeId)
    .executeTakeFirst()
  if (!row) throw notFound('Attribute')
  return row.hub_id
}

// ----------------------------------------------------------------------------------------
// Hub

/** `PATCH /hubs/:hubId`: name, colour and title attribute (D50), for hub admins. */
export async function updateHub(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  hubId: string,
  input: UpdateHub,
): Promise<Hub> {
  await requireHub(trx, workspaceId, hubId)
  const hubGrant = await ownGrant(trx, workspaceId, hubId, me.id, 'share')
  enforce(can(me, 'hub.rename', { hubGrant }), 'Hub')

  if (input.titleAttributeId) {
    // Step 3, before the hub row: an attribute delete holds the attribute and then takes the
    // hub row to clear the title.
    const attribute = await trx
      .selectFrom('attribute')
      .select('type')
      .where('workspace_id', '=', workspaceId)
      .where('hub_id', '=', hubId)
      .where('id', '=', input.titleAttributeId)
      .forKeyShare()
      .executeTakeFirst()
    if (attribute?.type !== 'text') {
      throw invalid('titleAttributeId: must be a text attribute of this hub')
    }
  }

  const hub = await lockHubRow(trx, workspaceId, hubId)
  if (hub.version !== input.version) throw schemaConflict('hub', toHub(hub))
  const row = await trx
    .updateTable('folder')
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.titleAttributeId !== undefined && { title_attribute_id: input.titleAttributeId }),
      version: sql`version + 1`,
    })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', hubId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return toHub(row)
}

/**
 * `DELETE /hubs/:hubId?version=` (D52) through delete_hub(), which checks everything again under
 * its locks. Its errors (migration 0009) map to 404, 409 `not_empty`, `in_use` and `conflict`,
 * and 403.
 */
export async function deleteHub(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  hubId: string,
  version: number,
): Promise<void> {
  await requireHub(trx, workspaceId, hubId)
  const hubGrant = await ownGrant(trx, workspaceId, hubId, me.id)
  // Only owners and admins can read every grant on a hub; for anyone else `can()` refuses
  // whatever this says.
  const owner = await trx
    .selectFrom('hub_grant as g')
    .innerJoin('principal as p', (j) =>
      j.onRef('p.workspace_id', '=', 'g.workspace_id').onRef('p.id', '=', 'g.principal_id'),
    )
    .select('p.id')
    .where('g.workspace_id', '=', workspaceId)
    .where('g.hub_id', '=', hubId)
    .where('p.workspace_role', '=', 'owner')
    .where('p.removed_at', 'is', null)
    .limit(1)
    .executeTakeFirst()
  enforce(can(me, 'hub.delete', { hubGrant, ownerHoldsGrant: owner !== undefined }), 'Hub')

  // A savepoint, so the current hub can be read for a 409 after delete_hub fails.
  await sql`SAVEPOINT delete_hub`.execute(trx)
  try {
    await sql`SELECT delete_hub(${hubId}, ${version})`.execute(trx)
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT delete_hub`.execute(trx)
    switch (sqlState(error)) {
      case '16B03':
        throw notFound('Hub')
      case '16B04':
        throw new HttpError('not_empty', 'The hub still holds folders or items')
      case '16B05':
        throw new HttpError('in_use', 'A relation attribute in another hub targets this hub')
      case '16B06': {
        const current = await trx
          .selectFrom('folder')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('id', '=', hubId)
          .executeTakeFirst()
        if (!current) throw notFound('Hub')
        throw schemaConflict('hub', toHub(current))
      }
      case '42501':
        throw forbidden()
      default:
        throw error
    }
  }
}

// ----------------------------------------------------------------------------------------
// Grants

const grantCursorSchema = z.tuple([z.string(), z.string()])

/**
 * `GET /hubs/:hubId/grants` (`grant.list`): who holds a grant on the hub, by name then principal
 * ID. Names and hub roles only, nothing inside the hub.
 */
export async function listHubGrants(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  hubId: string,
  query: PageQuery,
): Promise<Page<HubGrantEntry>> {
  await requireHub(trx, workspaceId, hubId)
  const hubGrant = await ownGrant(trx, workspaceId, hubId, me.id)
  enforce(can(me, 'grant.list', { hubGrant }), 'Hub')
  const after = query.cursor ? decodeCursor(grantCursorSchema, query.cursor) : null
  let q = trx
    .selectFrom('hub_grant as g')
    .innerJoin('principal as p', (j) =>
      j.onRef('p.workspace_id', '=', 'g.workspace_id').onRef('p.id', '=', 'g.principal_id'),
    )
    .select(['p.id', 'p.kind', 'p.name', 'p.workspace_role', 'g.hub_role'])
    .where('g.workspace_id', '=', workspaceId)
    .where('g.hub_id', '=', hubId)
    .where('p.removed_at', 'is', null)
  if (after) q = q.where(sql<boolean>`(p.name, p.id) > (${after[0]}, ${after[1]})`)
  const rows = await q
    .orderBy('p.name')
    .orderBy('p.id')
    .limit(query.limit + 1)
    .execute()
  const items = rows.slice(0, query.limit).map((r): HubGrantEntry => ({
    principalId: r.id,
    kind: r.kind,
    name: r.name,
    workspaceRole: r.workspace_role,
    hubRole: r.hub_role,
  }))
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > query.limit && last ? encodeCursor([last.name, last.principalId]) : null,
  }
}

// ----------------------------------------------------------------------------------------
// Folders

/** `POST /hubs/:hubId/folders`. The folder takes its hub's `idPrefix`. */
export async function createFolder(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  hubId: string,
  input: CreateFolder,
): Promise<Folder> {
  await requireHub(trx, workspaceId, hubId)
  await requireManage(trx, workspaceId, me, hubId, 'Hub')
  const hub = await lockHubRow(trx, workspaceId, hubId)
  const parent = await trx
    .selectFrom('folder')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where('id', '=', input.parentId)
    .executeTakeFirst()
  if (!parent) throw invalid('parentId: must be the hub or a folder in it')
  const row = await trx
    .insertInto('folder')
    .values({
      workspace_id: workspaceId,
      id: input.id ?? randomUUID(),
      hub_id: hubId,
      parent_id: input.parentId,
      name: input.name,
      color: input.color,
      id_prefix: hub.id_prefix,
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
    .returningAll()
    .executeTakeFirst()
  if (!row) throw new HttpError('id_taken', 'This folder ID is already used')
  return toFolder(row)
}

/** The folder row FOR NO KEY UPDATE with its version checked, or 404 / 409. */
async function lockFolder(trx: Trx, workspaceId: string, folderId: string, version: number) {
  const row = await trx
    .selectFrom('folder')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', folderId)
    .forNoKeyUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('Folder')
  if (row.version !== version) throw schemaConflict('folder', toFolder(row))
  return row
}

/** `PATCH /folders/:folderId`: rename, recolour or move a folder that is not a hub. */
export async function updateFolder(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  folderId: string,
  input: UpdateFolder,
): Promise<Folder> {
  const hubId = await hubOfFolder(trx, workspaceId, folderId)
  await requireManage(trx, workspaceId, me, hubId, 'Folder')
  if (folderId === hubId) throw invalid('A hub is changed with PATCH /hubs/:hubId')

  if (input.parentId !== undefined) {
    // Moves in a hub are serialised on its row (step 5), so the cycle check below holds.
    await lockHubRow(trx, workspaceId, hubId)
    const parent = await trx
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('hub_id', '=', hubId)
      .where('id', '=', input.parentId)
      .executeTakeFirst()
    if (!parent) throw invalid('parentId: must be the hub or a folder of the same hub')
    const { rows } = await sql<{ cycle: boolean }>`
      WITH RECURSIVE up (id, parent_id) AS (
        SELECT f.id, f.parent_id FROM folder f
        WHERE f.workspace_id = ${workspaceId} AND f.id = ${input.parentId}
        UNION
        SELECT f.id, f.parent_id FROM folder f JOIN up ON f.id = up.parent_id
        WHERE f.workspace_id = ${workspaceId})
      SELECT EXISTS (SELECT 1 FROM up WHERE up.id = ${folderId}) AS cycle
    `.execute(trx)
    if (rows[0]?.cycle) {
      throw invalid('parentId: a folder cannot move into itself or one of its subfolders')
    }
  }

  await lockFolder(trx, workspaceId, folderId, input.version)
  try {
    const row = await trx
      .updateTable('folder')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.parentId !== undefined && { parent_id: input.parentId }),
        version: sql`version + 1`,
      })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folderId)
      .returningAll()
      .executeTakeFirstOrThrow()
    return toFolder(row)
  } catch (error) {
    // folder_parent_check, the database's backstop against cycles.
    if (sqlState(error) === '23514') {
      throw invalid('parentId: a folder cannot move into itself or one of its subfolders')
    }
    throw error
  }
}

/** `DELETE /folders/:folderId?version=`: an empty folder that is not a hub (D52). */
export async function deleteFolder(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  folderId: string,
  version: number,
): Promise<void> {
  const hubId = await hubOfFolder(trx, workspaceId, folderId)
  await requireManage(trx, workspaceId, me, hubId, 'Folder')
  if (folderId === hubId) throw invalid('A hub is deleted with DELETE /hubs/:hubId')

  // The hub row first (step 5): an item create in this folder has then either committed, and
  // is seen below, or waits for the hub row and then finds no folder. An item delete in flight
  // still counts, since its row is not gone until it commits.
  await lockHubRow(trx, workspaceId, hubId)
  await lockFolder(trx, workspaceId, folderId, version)
  const { rows } = await sql<{ busy: boolean }>`
    SELECT EXISTS (SELECT 1 FROM item i
                   WHERE i.workspace_id = ${workspaceId} AND i.folder_id = ${folderId})
        OR EXISTS (SELECT 1 FROM folder f
                   WHERE f.workspace_id = ${workspaceId} AND f.parent_id = ${folderId}) AS busy
  `.execute(trx)
  if (rows[0]?.busy) throw new HttpError('not_empty', 'The folder still holds folders or items')

  // Attached attributes first: the foreign key refuses the folder otherwise.
  await trx
    .deleteFrom('folder_attribute')
    .where('workspace_id', '=', workspaceId)
    .where('folder_id', '=', folderId)
    .execute()
  await trx
    .deleteFrom('folder')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', folderId)
    .execute()
}

// ----------------------------------------------------------------------------------------
// Which attributes a folder shows

async function folderAttributeRows(trx: Trx, workspaceId: string, folderId: string) {
  return trx
    .selectFrom('folder_attribute')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('folder_id', '=', folderId)
    .orderBy('position')
    .orderBy('attribute_id')
    .execute()
}

/**
 * `PUT /folders/:folderId/attributes`: attach, detach, reorder and set `required` in one call,
 * checking and bumping `folder.version`. With `dryRun`, nothing is written. Either way the
 * response counts the items of the folder that leave each required attribute empty (D51).
 */
export async function setFolderAttributes(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  folderId: string,
  input: SetFolderAttributes & { dryRun: boolean },
): Promise<FolderAttributesResult> {
  const hubId = await hubOfFolder(trx, workspaceId, folderId)
  await requireManage(trx, workspaceId, me, hubId, 'Folder')
  const list = input.attributes.map((a) => ({
    attributeId: a.attributeId,
    required: a.required ?? false,
  }))
  const ids = list.map((a) => a.attributeId)

  // Step 3: the attributes, so none is deleted under the new rows.
  if (ids.length > 0) {
    const found = await trx
      .selectFrom('attribute')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('hub_id', '=', hubId)
      .where('id', 'in', ids)
      .orderBy('id')
      .forKeyShare()
      .execute()
    const known = new Set(found.map((r) => r.id))
    const missing = ids.find((id) => !known.has(id))
    if (missing !== undefined) {
      throw invalid(`attributes: "${missing}" is not an attribute of this hub`)
    }
  }

  const folder = await trx
    .selectFrom('folder')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', folderId)
    .forNoKeyUpdate()
    .executeTakeFirst()
  if (!folder) throw notFound('Folder')
  if (folder.version !== input.version) {
    const current = await folderAttributeRows(trx, workspaceId, folderId)
    throw schemaConflict('folder', {
      folder: toFolder(folder),
      attributes: current.map(toFolderAttribute),
    })
  }

  let result = { folder: toFolder(folder), attributes: [] as FolderAttributesResult['attributes'] }
  if (input.dryRun) {
    result.attributes = list.map((a, position) => ({
      workspaceId,
      hubId,
      folderId,
      attributeId: a.attributeId,
      position,
      required: a.required,
    }))
  } else {
    let detach = trx
      .deleteFrom('folder_attribute')
      .where('workspace_id', '=', workspaceId)
      .where('folder_id', '=', folderId)
    if (ids.length > 0) detach = detach.where('attribute_id', 'not in', ids)
    await detach.execute()
    if (list.length > 0) {
      await trx
        .insertInto('folder_attribute')
        .values(
          list.map((a, position) => ({
            workspace_id: workspaceId,
            hub_id: hubId,
            folder_id: folderId,
            attribute_id: a.attributeId,
            position,
            required: a.required,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'folder_id', 'attribute_id']).doUpdateSet((eb) => ({
            position: eb.ref('excluded.position'),
            required: eb.ref('excluded.required'),
          })),
        )
        .execute()
    }
    const updated = await trx
      .updateTable('folder')
      .set({ version: sql`version + 1` })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', folderId)
      .returningAll()
      .executeTakeFirstOrThrow()
    const rows = await folderAttributeRows(trx, workspaceId, folderId)
    result = { folder: toFolder(updated), attributes: rows.map(toFolderAttribute) }
  }

  // One pass over the folder's items for every required attribute (D51).
  const required = list.filter((a) => a.required).map((a) => a.attributeId)
  const counts = new Map<string, number>()
  if (required.length > 0) {
    const { rows } = await sql<{ attribute_id: string; n: number }>`
      SELECT k.attribute_id, count(i.id)::int AS n
      FROM unnest(${required}::text[]) AS k (attribute_id)
      LEFT JOIN item i
        ON i.workspace_id = ${workspaceId} AND i.folder_id = ${folderId}
       AND NOT (i.values ? k.attribute_id)
      GROUP BY k.attribute_id
    `.execute(trx)
    for (const r of rows) counts.set(r.attribute_id, r.n)
  }
  return {
    ...result,
    requiredEmpty: required.map((attributeId) => ({
      attributeId,
      items: counts.get(attributeId) ?? 0,
    })),
  }
}

// ----------------------------------------------------------------------------------------
// Attributes

/**
 * `POST /hubs/:hubId/attributes`. A relation into another hub needs `crossHub` (checked by
 * `attributeSchema`) and `relation.target` on that hub; a missing target and a hidden one are
 * both 404 (docs/ROLES.md).
 */
export async function createAttribute(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  hubId: string,
  input: CreateAttribute,
): Promise<Attribute> {
  await requireHub(trx, workspaceId, hubId)
  await requireManage(trx, workspaceId, me, hubId, 'Hub')
  const parsed = attributeSchema.safeParse({
    ...input,
    id: input.id ?? randomUUID(),
    workspaceId,
    hubId,
    version: 0,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalid(`${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'Invalid attribute'}`)
  }
  const attribute = parsed.data
  const crossHub = attribute.type === 'relation' && attribute.config.targetHubId !== hubId
  if (crossHub) {
    // Step 1, before the insert: see the lock order at the top.
    const target = attribute.config.targetHubId
    const hubGrant = await ownGrant(trx, workspaceId, target, me.id, 'share')
    enforce(can(me, 'relation.target', { hubGrant }), 'Hub')
  }
  try {
    const row = await trx
      .insertInto('attribute')
      .values({
        workspace_id: workspaceId,
        id: attribute.id,
        hub_id: hubId,
        name: attribute.name,
        type: attribute.type,
        config: JSON.stringify(attribute.config),
        indexed: attribute.indexed,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'id']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) throw new HttpError('id_taken', 'This attribute ID is already used')
    return toAttribute(row)
  } catch (error) {
    // attribute_target_lock: the target hub was deleted after the grant check.
    if (crossHub && sqlState(error) === '42501') throw notFound('Hub')
    throw error
  }
}

/** The attribute row locked for a write with its version checked, or 404 / 409. */
async function lockAttribute(
  trx: Trx,
  workspaceId: string,
  attributeId: string,
  version: number,
  mode: 'update' | 'noKeyUpdate',
) {
  const q = trx
    .selectFrom('attribute')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', attributeId)
  const row = await (mode === 'update' ? q.forUpdate() : q.forNoKeyUpdate()).executeTakeFirst()
  if (!row) throw notFound('Attribute')
  if (row.version !== version) throw schemaConflict('attribute', toAttribute(row))
  return row
}

/** An item whose value for one attribute is about to change: only that value is loaded. */
interface Affected {
  id: string
  hub_id: string
  value: ItemValues[string] | undefined
}

/**
 * The hub's items that `holds` matches, locked FOR NO KEY UPDATE in ID order (step 4), with
 * their value for `attributeId` only, not the whole `values`. With any, `confirm` must be their
 * number (D51), or the write is a 409 `confirm_required`.
 */
async function lockAffected(
  trx: Trx,
  workspaceId: string,
  hubId: string,
  attributeId: string,
  holds: RawBuilder<boolean>,
  confirm: number | undefined,
): Promise<Affected[]> {
  const items = await trx
    .selectFrom('item')
    .select([
      'id',
      'hub_id',
      sql<ItemValues[string] | undefined>`${sql.ref('values')} -> ${attributeId}::text`.as('value'),
    ])
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where(holds)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute()
  if (items.length > 0 && confirm !== items.length) {
    throw new HttpError(
      'confirm_required',
      `This removes values from ${String(items.length)} items. Send confirm: ${String(items.length)} to go ahead.`,
      { affected: items.length },
    )
  }
  return items
}

/**
 * Writes `next(value)` for `attribute` into each item: a new value, or `null` to remove it.
 * One UPDATE for all items (new version each); item_index follows when `reindex` and the
 * attribute is indexed (a deleted attribute's rows and links go with it, by cascade). The
 * revisions come last, in one batch (`appendRevisions`), so the workspace row is taken after
 * every item is written and held only briefly (step 7).
 */
async function stripValues(
  trx: Trx,
  workspaceId: string,
  actor: string,
  attribute: Attribute,
  items: Affected[],
  next: (value: ItemValues[string] | undefined) => ItemValues[string],
  reindex: boolean,
): Promise<void> {
  if (items.length === 0) return
  const key = attribute.id
  const changes = items.map((item) => ({ id: item.id, value: next(item.value) }))
  const { rows } = await sql<{ id: string; hub_id: string; version: number }>`
    UPDATE item i
    SET values = CASE WHEN v.val IS NULL THEN i.values - ${key}::text
                      ELSE i.values || jsonb_build_object(${key}::text, v.val) END,
        version = i.version + 1,
        updated_at = now(),
        updated_by = ${actor}
    FROM unnest(${changes.map((c) => c.id)}::text[],
                ${changes.map((c) => (c.value === null ? null : JSON.stringify(c.value)))}::jsonb[])
         AS v (id, val)
    WHERE i.workspace_id = ${workspaceId} AND i.id = v.id
    RETURNING i.id, i.hub_id, i.version
  `.execute(trx)

  if (reindex && attribute.indexed) {
    const ids = changes.map((c) => c.id)
    await trx
      .deleteFrom('item_index')
      .where('workspace_id', '=', workspaceId)
      .where('attribute_id', '=', key)
      .where(sql<boolean>`item_id = ANY(${ids}::text[])`)
      .execute()
    const index = changes.flatMap((c) =>
      indexEntries(attribute, c.value).map((entry) => ({
        workspace_id: workspaceId,
        attribute_id: key,
        item_id: c.id,
        ord: entry.ord,
        num: entry.column === 'num' ? (entry.value as number) : null,
        txt: entry.column === 'txt' ? (entry.value as string) : null,
        ts: entry.column === 'ts' ? (entry.value as string) : null,
      })),
    )
    for (let i = 0; i < index.length; i += 1000) {
      await trx
        .insertInto('item_index')
        .values(index.slice(i, i + 1000))
        .execute()
    }
  }

  const valueOf = new Map(changes.map((c) => [c.id, c.value]))
  await appendRevisions(
    trx,
    workspaceId,
    actor,
    rows
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({
        hubId: r.hub_id,
        itemId: r.id,
        version: r.version,
        patch: { op: 'update', values: { [key]: valueOf.get(r.id) ?? null } },
      })),
  )
}

/**
 * `PATCH /attributes/:attributeId`: the name and, for select and multi-select, the options
 * (D51). Removing options that items hold needs `confirm`, and strips them from those items.
 */
export async function updateAttribute(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  attributeId: string,
  input: UpdateAttribute,
): Promise<Attribute> {
  const hubId = await hubOfAttribute(trx, workspaceId, attributeId)
  await requireManage(trx, workspaceId, me, hubId, 'Attribute')
  // Which options go is decided on the attribute as the client saw it. Every write moves the
  // version, so if the locked row below still has that version, it has these options too.
  const seen = await trx
    .selectFrom('attribute')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', attributeId)
    .executeTakeFirst()
  if (!seen) throw notFound('Attribute')
  if (seen.version !== input.version) throw schemaConflict('attribute', toAttribute(seen))
  const result = applyAttributeUpdate(toAttribute(seen), input)
  if (!result.ok) throw invalid(result.message)
  const { removedOptionIds: removed } = result
  // Step 2, only when options are removed: a rename or a new option strips nothing.
  if (removed.length > 0) await lockHubSchema(trx, workspaceId, hubId, 'exclusive')
  await lockAttribute(trx, workspaceId, attributeId, input.version, 'noKeyUpdate')

  const items =
    removed.length > 0
      ? await lockAffected(
          trx,
          workspaceId,
          hubId,
          attributeId,
          sql<boolean>`${sql.ref('values')} -> ${attributeId}::text ?| ${removed}::text[]`,
          input.confirm,
        )
      : []

  const updated = await trx
    .updateTable('attribute')
    .set({
      name: result.attribute.name,
      config: JSON.stringify(result.attribute.config),
      version: sql`version + 1`,
    })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', attributeId)
    .returningAll()
    .executeTakeFirstOrThrow()
  const attribute = toAttribute(updated)

  const gone = new Set(removed)
  await stripValues(
    trx,
    workspaceId,
    me.id,
    attribute,
    items,
    (value) => {
      if (Array.isArray(value)) {
        const kept = value.filter((id) => !gone.has(id))
        return kept.length > 0 ? kept : null
      }
      return typeof value === 'string' && gone.has(value) ? null : (value ?? null)
    },
    true,
  )
  return attribute
}

/**
 * `DELETE /attributes/:attributeId?version=&confirm=`: strips its values (with `confirm` when
 * items hold one), detaches it from every folder (bumping their versions), clears it as the
 * hub's title (D50), and deletes it with its item_index and link rows.
 */
export async function deleteAttribute(
  trx: Trx,
  workspaceId: string,
  me: Subject,
  attributeId: string,
  query: DeleteAttributeQuery,
): Promise<void> {
  const hubId = await hubOfAttribute(trx, workspaceId, attributeId)
  await requireManage(trx, workspaceId, me, hubId, 'Attribute')
  await lockHubSchema(trx, workspaceId, hubId, 'exclusive')
  const row = await lockAttribute(trx, workspaceId, attributeId, query.version, 'update')
  const attribute = toAttribute(row)
  const items = await lockAffected(
    trx,
    workspaceId,
    hubId,
    attributeId,
    sql<boolean>`${sql.ref('values')} ? ${attributeId}::text`,
    query.confirm,
  )

  // Steps 5 and 6: the hub row, then every folder that shows the attribute, in ID order. Each
  // changes, so each version moves (the hub's too when the attribute was its title).
  const hub = await lockHubRow(trx, workspaceId, hubId)
  const attached = await trx
    .selectFrom('folder_attribute')
    .select('folder_id')
    .where('workspace_id', '=', workspaceId)
    .where('attribute_id', '=', attributeId)
    .execute()
  const folderIds = new Set(attached.map((r) => r.folder_id))
  if (hub.title_attribute_id === attributeId) folderIds.add(hubId)
  const others = [...folderIds].filter((id) => id !== hubId).sort()
  if (others.length > 0) {
    await trx
      .selectFrom('folder')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', others)
      .orderBy('id')
      .forNoKeyUpdate()
      .execute()
  }
  for (const id of [...(folderIds.has(hubId) ? [hubId] : []), ...others]) {
    await trx
      .updateTable('folder')
      .set({
        version: sql`version + 1`,
        ...(id === hubId && hub.title_attribute_id === attributeId && { title_attribute_id: null }),
      })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .execute()
  }
  await trx
    .deleteFrom('folder_attribute')
    .where('workspace_id', '=', workspaceId)
    .where('attribute_id', '=', attributeId)
    .execute()
  await trx
    .deleteFrom('attribute')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', attributeId)
    .execute()

  // Step 7: the revisions take the workspace row.
  await stripValues(trx, workspaceId, me.id, attribute, items, () => null, false)
}
