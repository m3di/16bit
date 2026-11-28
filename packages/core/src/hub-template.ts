import { z } from 'zod'
import { createHubSchema } from './api.ts'
import { type Attribute, attributeVariants, folderSchema, idSchema } from './entities.ts'
import { MAX_FOLDER_ATTRIBUTES, schemaNameSchema } from './hub-settings.ts'
import { paletteColorSchema } from './palette.ts'
import type { QueryError } from './query.ts'
import { checkViewTree, parseViewTree, type ViewTree } from './views.ts'

// Hub templates (D71, #205): a hub's folders, attributes and root views, without items, as one
// JSON document. `GET /v1/workspaces/:workspaceId/hubs/:hubId/template` exports one
// (`hub.read`: it holds nothing the hub description and view reads don't) and
// `POST /v1/workspaces/:workspaceId/hubs/import` creates a new hub from one. Served from #211.
//
// IDs in a template are the exported hub's own and only tie its parts together. Import never
// merges: it always creates a new hub and gives the hub, every folder and every attribute a new
// ID, rewriting every reference to them (parents, folder attributes, the title attribute,
// opens-on, relation targets, and the folder and attribute IDs in view trees). Option IDs and
// block IDs are local to their attribute or tree, so they are kept.

export const HUB_TEMPLATE_FORMAT = '16bit.hub-template'
export const HUB_TEMPLATE_VERSION = 1
/** Folders one template holds besides the hub. */
export const MAX_TEMPLATE_FOLDERS = 200
/** Attributes one template holds. */
export const MAX_TEMPLATE_ATTRIBUTES = 200

/** The attributes a folder (or the hub) shows, in order, as `PUT /folders/:id/attributes`. */
const shownAttributesSchema = z
  .array(z.strictObject({ attributeId: idSchema, required: z.boolean().default(false) }))
  .max(MAX_FOLDER_ATTRIBUTES)

export const templateFolderSchema = z.strictObject({
  id: idSchema,
  /** The hub's `id`, or a folder listed before this one. */
  parentId: idSchema,
  name: schemaNameSchema,
  color: paletteColorSchema,
  /** Present, and `true`, only on a views-only folder (D76). */
  viewsOnly: z.literal(true).optional(),
  attributes: shownAttributesSchema.default([]),
})
export type TemplateFolder = z.infer<typeof templateFolderSchema>

/**
 * An attribute as `POST /hubs/:hubId/attributes` takes it, with its ID required. A relation
 * must target the template's own hub with `crossHub` off: a template can't point outside
 * itself (`checkHubTemplate`).
 */
export const templateAttributeSchema = z.discriminatedUnion(
  'type',
  attributeVariants({ id: idSchema, name: schemaNameSchema, indexed: z.boolean().default(false) }),
)
export type TemplateAttribute = z.infer<typeof templateAttributeSchema>

/** One folder's root view (D76). `tree` is read with `parseViewTree`, so older versions upgrade. */
export const templateViewSchema = z.strictObject({
  /** The hub's `id` or a folder's. */
  folderId: idSchema,
  tree: z.unknown(),
})

/**
 * A hub template, version 1. An unknown `format` or `version` is refused, never guessed at.
 * `hub.titleAttributeId` names a `text` attribute of the template or is `null` (D50);
 * `hub.opensOnFolderId` names one of its folders (D76). Folders are listed parents first.
 */
export const hubTemplateSchema = z.strictObject({
  format: z.literal(HUB_TEMPLATE_FORMAT),
  version: z.literal(HUB_TEMPLATE_VERSION, {
    error: `Only version ${String(HUB_TEMPLATE_VERSION)} templates can be read`,
  }),
  hub: z.strictObject({
    id: idSchema,
    name: schemaNameSchema,
    color: paletteColorSchema,
    idPrefix: folderSchema.shape.idPrefix,
    titleAttributeId: idSchema.nullable(),
    opensOnFolderId: idSchema.optional(),
    attributes: shownAttributesSchema.default([]),
  }),
  folders: z.array(templateFolderSchema).max(MAX_TEMPLATE_FOLDERS),
  attributes: z.array(templateAttributeSchema).max(MAX_TEMPLATE_ATTRIBUTES),
  views: z.array(templateViewSchema).max(MAX_TEMPLATE_FOLDERS + 1),
})
export type HubTemplate = z.output<typeof hubTemplateSchema>
export type HubTemplateInput = z.input<typeof hubTemplateSchema>

export type CheckHubTemplateResult =
  | { ok: true; template: HubTemplate; views: { folderId: string; tree: ViewTree }[] }
  | { ok: false; errors: QueryError[] }

const issuePath = (path: readonly PropertyKey[]) => path.map(String).join('.')

/**
 * Reads a template: its shape, then that it holds together. Every ID is unique; each folder's
 * parent is the hub or a folder before it; every shown attribute, the title attribute and
 * opens-on name something in the template; relations target the template's hub with `crossHub`
 * off; each folder has at most one view, and each view parses and passes `checkViewTree`
 * against the template's own folders and attributes. Returns every problem, with paths like
 * `folders.2.parentId`, for 422 `invalid_template`. The returned views are parsed, defaults
 * filled in.
 */
export function checkHubTemplate(raw: unknown): CheckHubTemplateResult {
  const parsed = hubTemplateSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message })),
    }
  }
  const template = parsed.data
  const errors: QueryError[] = []
  const hubId = template.hub.id

  const attributeById = new Map<string, Attribute>()
  for (const [i, a] of template.attributes.entries()) {
    if (attributeById.has(a.id)) {
      errors.push({ path: `attributes.${String(i)}.id`, message: `"${a.id}" is used twice` })
      continue
    }
    if (a.type === 'relation' && (a.config.targetHubId !== hubId || a.config.crossHub)) {
      errors.push({
        path: `attributes.${String(i)}.config`,
        message: `A template's relations target its own hub "${hubId}" with crossHub off`,
      })
    }
    attributeById.set(a.id, { ...a, workspaceId: '_', hubId, version: 0 })
  }

  const shown = (list: readonly { attributeId: string }[], path: string): Attribute[] => {
    const seen = new Set<string>()
    const out: Attribute[] = []
    for (const [i, { attributeId }] of list.entries()) {
      const attribute = attributeById.get(attributeId)
      if (!attribute) {
        errors.push({
          path: `${path}.${String(i)}.attributeId`,
          message: `"${attributeId}" is not an attribute of the template`,
        })
      } else if (seen.has(attributeId)) {
        errors.push({
          path: `${path}.${String(i)}.attributeId`,
          message: `"${attributeId}" is shown twice`,
        })
      } else {
        seen.add(attributeId)
        out.push(attribute)
      }
    }
    return out
  }

  const folders = new Map<string, { viewsOnly: boolean; attributes: readonly Attribute[] }>()
  folders.set(hubId, {
    viewsOnly: false,
    attributes: shown(template.hub.attributes, 'hub.attributes'),
  })
  for (const [i, f] of template.folders.entries()) {
    const at = `folders.${String(i)}`
    if (folders.has(f.id) || attributeById.has(f.id)) {
      errors.push({ path: `${at}.id`, message: `"${f.id}" is used twice` })
      continue
    }
    if (!folders.has(f.parentId)) {
      errors.push({
        path: `${at}.parentId`,
        message: `"${f.parentId}" must be the hub or a folder listed before this one`,
      })
    }
    folders.set(f.id, {
      viewsOnly: f.viewsOnly === true,
      attributes: shown(f.attributes, `${at}.attributes`),
    })
  }
  if (attributeById.has(hubId)) {
    errors.push({ path: 'hub.id', message: `"${hubId}" is also an attribute's ID` })
  }

  const title = template.hub.titleAttributeId
  if (title !== null && attributeById.get(title)?.type !== 'text') {
    errors.push({
      path: 'hub.titleAttributeId',
      message: `"${title}" must be a text attribute of the template`,
    })
  }
  const opensOn = template.hub.opensOnFolderId
  if (opensOn !== undefined && (opensOn === hubId || !folders.has(opensOn))) {
    errors.push({
      path: 'hub.opensOnFolderId',
      message: `"${opensOn}" must be a folder of the template other than the hub`,
    })
  }

  const views: { folderId: string; tree: ViewTree }[] = []
  const viewed = new Set<string>()
  for (const [i, v] of template.views.entries()) {
    const at = `views.${String(i)}`
    if (!folders.has(v.folderId)) {
      errors.push({
        path: `${at}.folderId`,
        message: `"${v.folderId}" is not the hub or a folder of the template`,
      })
      continue
    }
    if (viewed.has(v.folderId)) {
      errors.push({ path: `${at}.folderId`, message: `"${v.folderId}" has a view already` })
      continue
    }
    viewed.add(v.folderId)
    const tree = parseViewTree(v.tree)
    if (!tree.ok) {
      for (const e of tree.errors) errors.push({ path: `${at}.tree.${e.path}`, message: e.message })
      continue
    }
    for (const e of checkViewTree(tree.tree, { folders })) {
      errors.push({ path: `${at}.tree.${e.path}`, message: e.message })
    }
    views.push({ folderId: v.folderId, tree: tree.tree })
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, template, views }
}

/**
 * `POST /v1/workspaces/:workspaceId/hubs/import`, as `POST /hubs`: owners and admins, and the
 * importer becomes the new hub's hub admin. `template` is read with `checkHubTemplate` (422
 * `invalid_template` with `errors`). `name`, `color` and `idPrefix` replace the template's; a
 * prefix in use is 409 `prefix_taken` (D56), so importing a template twice needs a new one.
 * Answers 201 with the new hub as a `granted` hub list entry, like `POST /hubs`.
 */
export const importHubTemplateSchema = z.strictObject({
  template: z.unknown(),
  name: createHubSchema.shape.name.optional(),
  color: paletteColorSchema.optional(),
  idPrefix: folderSchema.shape.idPrefix.optional(),
})
export type ImportHubTemplate = z.input<typeof importHubTemplateSchema>
