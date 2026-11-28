import { z } from 'zod'
import { aggregateRequestSchema, timeZoneSchema } from './aggregate.ts'
import {
  clientMutationIdSchema,
  createItemSchema,
  itemCauseSchema,
  itemQuerySchema,
  patchItemFields,
  requireAChange,
  seqSchema,
  upsertItemSchema,
} from './api.ts'
import { freshForSchema } from './attribute-types/index.ts'
import {
  batchCreateSchema,
  batchDeleteSchema,
  batchPatchSchema,
  batchUpsertSchema,
  MAX_BATCH_OPERATIONS,
} from './batch.ts'
import { idSchema } from './entities.ts'
import { externalKeySchema } from './external-key.ts'
import { DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT } from './feed.ts'
import { neighbourFields } from './neighbours.ts'
import { expandSchema } from './query.ts'
import { searchFields } from './search.ts'
import { MAX_VIEW_BLOCKS } from './views.ts'

// The MCP tools (D22, D88, #205): one tool per HTTP route, served at `POST /mcp` (D87). Each
// tool runs its route in process with only the headers the server builds, so permissions,
// row-level security, limits and error bodies are exactly the HTTP ones. A tool's result is the
// route's JSON as `structuredContent`, with the same text alongside; an error status is
// `isError: true` with the API's error body (409 `conflict`, 412 `precondition_failed`, ...).
//
// Inputs are Zod object schemas, which the MCP TypeScript SDK v2 takes as `inputSchema` and
// turns into the JSON Schema it lists. This file depends on Zod only, never on the SDK. No
// input has a `workspaceId` or `hubId`: an agent key belongs to exactly one hub (D28, D47), and
// the server fills them in. Every write takes `clientMutationId` (D59) and `cause` (D63).
// Query strings become JSON here: numbers as numbers and lists as arrays.

const writeFields = {
  clientMutationId: clientMutationIdSchema.optional(),
  cause: itemCauseSchema.optional(),
}

/** The two attributes a claim lives in (D68): the caller names them on every call. */
const claimFields = {
  itemId: idSchema,
  /** An actor attribute: who holds the claim. */
  actorAttributeId: idSchema,
  /** A date attribute with time: until when. */
  untilAttributeId: idSchema,
}

/**
 * How long a claim lasts from the server clock, as `freshFor` takes it (1 minute to 366 days).
 * Absent: the date attribute's `freshFor`; a 400 when it has none.
 */
const claimDuration = { duration: freshForSchema.optional() }

/**
 * `batchRequestSchema` with the upsert operation's `hubId` left out: the server fills it in, as
 * for every tool. The route still checks the whole body, duplicate mutation IDs included.
 */
const batchWriteInput = z.strictObject({
  operations: z
    .array(
      z.discriminatedUnion('op', [
        batchCreateSchema,
        batchPatchSchema,
        batchDeleteSchema,
        batchUpsertSchema.omit({ hubId: true }),
      ]),
    )
    .min(1)
    .max(MAX_BATCH_OPERATIONS),
})

/** MCP tool annotations. A host may auto-approve read-only tools and confirm destructive ones. */
export interface McpToolAnnotations {
  readOnlyHint: boolean
  /** Only meaningful for writes: false means it only adds. */
  destructiveHint: boolean
  /** The same call twice has the same effect as once. */
  idempotentHint: boolean
  /** Talks to this server only, never the open world. */
  openWorldHint: false
}

export interface McpToolContract {
  title: string
  description: string
  input: z.ZodObject
  annotations: McpToolAnnotations
}

const read: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const write = (destructive: boolean, idempotent: boolean): McpToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
})

/** M5-01 (#318): the routes that exist today. */
export const MCP_WAVE_1_TOOLS = [
  'describe_hub',
  'get_items',
  'get_item_by_key',
  'query_items',
  'aggregate',
  'read_view',
  'get_changes',
  'create_item',
  'patch_item',
  'delete_item',
  'upsert_item',
  'batch_write',
] as const

/** Later in M5, each with its route or, for claims, its issue (M5-02, #206, #207, #210). */
export const MCP_LATER_TOOLS = [
  'digest',
  'neighbours',
  'search',
  'claim_item',
  'renew_claim',
  'release_claim',
] as const

export const MCP_TOOL_NAMES = [...MCP_WAVE_1_TOOLS, ...MCP_LATER_TOOLS] as const
export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export const MCP_TOOLS = {
  describe_hub: {
    title: 'Describe the hub',
    description:
      "The agent key's hub with its folders, attributes and which attributes each folder shows, and your role in it. `GET /hubs/:hubId`. Read it first: every other tool names folders and attributes by these IDs.",
    input: z.strictObject({}),
    annotations: read,
  },
  get_items: {
    title: 'Get an item',
    description:
      'One item by ID, optionally with the items it links to through up to 3 relation attributes (`expand`). `GET /items/:itemId`. A missing item and one you cannot read are both 404.',
    input: z.strictObject({ itemId: idSchema, expand: expandSchema.optional() }),
    annotations: read,
  },
  get_item_by_key: {
    title: 'Get an item by external key',
    description:
      'The item of the hub holding an external key (D64), optionally with `expand`. `GET /hubs/:hubId/items/by-key/:key`. 404 when no item holds it.',
    input: z.strictObject({ key: externalKeySchema, expand: expandSchema.optional() }),
    annotations: read,
  },
  query_items: {
    title: 'Query items',
    description:
      'Items of one folder (`from`), filtered (`where`) and sorted on indexed attributes, with a required `limit` (1 to 200) and cursor paging. `POST /query`. Operands may be `{ "$me": true }` in an actor\'s `in` list and `{ "$now": "-P1D" }` on dates. A filter or sort the folder can\'t serve is a 400 naming it.',
    input: itemQuerySchema,
    annotations: read,
  },
  aggregate: {
    title: 'Aggregate items',
    description:
      'Counts, sums, averages and other summaries over one folder, optionally grouped by one attribute or date bucket. `POST /aggregate`. Up to 5 measures, each with its own `where`.',
    input: aggregateRequestSchema,
    annotations: read,
  },
  read_view: {
    title: 'Read a view',
    description:
      "Every data block of a folder's root view in one snapshot, each with its status. `GET /folders/:folderId/view/data`. `version` is the view's tree version: send 0 if you don't know it, and a 409 `stale` answers the version to send. `tz` is an IANA zone for dates (UTC when absent).",
    input: z.strictObject({
      folderId: idSchema,
      version: z.int().min(0),
      blocks: z.array(idSchema).min(1).max(MAX_VIEW_BLOCKS).optional(),
      tz: timeZoneSchema.optional(),
    }),
    annotations: read,
  },
  get_changes: {
    title: 'Get changes',
    description:
      "Item changes in your hub after a sequence number, oldest first, each with the item as it is now (`null` when deleted). `GET /changes`. Ask again with `after` set to the answer's `seq`; `more` says more are waiting.",
    input: z.strictObject({
      after: seqSchema,
      limit: z.int().min(1).max(MAX_CHANGES_LIMIT).default(DEFAULT_CHANGES_LIMIT),
    }),
    annotations: read,
  },
  create_item: {
    title: 'Create an item',
    description:
      'Creates an item in a folder. `POST /items`. `values` are keyed by attribute ID; `externalKey` is your own key for it (409 `key_taken` if another item holds it). A date value may be `{ "$now": "PT2H" }`. Send a `clientMutationId` so a retry is safe, and a `cause` to say why.',
    input: createItemSchema,
    annotations: write(false, false),
  },
  patch_item: {
    title: 'Update an item',
    description:
      "Merges `values` into an item (`null` clears one). `PATCH /items/:itemId`. `version` is the version you last read: a stale one is 409 `conflict` with the item as it is now. `condition` is a filter on the item's current values; when it fails nothing is written and the answer is 412 `precondition_failed`.",
    input: requireAChange(z.strictObject({ itemId: idSchema, ...patchItemFields })),
    annotations: write(true, false),
  },
  delete_item: {
    title: 'Delete an item',
    description:
      'Deletes an item at the version you last read (409 `conflict` if it moved). `DELETE /items/:itemId`. Its history stays.',
    input: z.strictObject({ itemId: idSchema, version: z.int().min(1), ...writeFields }),
    annotations: write(true, true),
  },
  upsert_item: {
    title: 'Create or update an item by external key',
    description:
      'Patches the item holding `key`, or creates it in `folderId` when none does (D64). `PUT /hubs/:hubId/items/by-key/:key`. Without `version` it is last write wins on the values sent; `condition` as for `patch_item`.',
    input: z.strictObject({ key: externalKeySchema, ...upsertItemSchema.shape }),
    annotations: write(true, true),
  },
  batch_write: {
    title: 'Write several items',
    description:
      'Up to 100 creates, patches, deletes and upserts, run in order, each in its own transaction with its own result, so one failure does not stop the rest (D65). `POST /items/batch`. A relation value may name an item of the hub as `{ "externalKey": "..." }`, including one created earlier in the batch.',
    input: batchWriteInput,
    annotations: write(true, false),
  },
  digest: {
    title: 'Read a folder as text',
    description:
      "A folder's root view rendered as compact Markdown: what a person sees on the page, in one call (D86). `GET /folders/:folderId/view/digest`. At most 32 KiB; `truncated` says it was cut. With `version`, a view that moved since is 409 `stale`.",
    input: z.strictObject({
      folderId: idSchema,
      version: z.int().min(0).optional(),
      tz: timeZoneSchema.optional(),
    }),
    annotations: read,
  },
  neighbours: {
    title: 'Read linked items',
    description:
      "An item's local graph: the items it links to (`out`), that link to it (`in`), or both, up to 2 links away and at most `limit` items (D67). `GET /items/:itemId/neighbours`. Items you can't read are counted in `hidden`, never named.",
    input: z.strictObject({ itemId: idSchema, ...neighbourFields }),
    annotations: read,
  },
  search: {
    title: 'Search the hub',
    description:
      'Items whose title or text attributes contain `q` (2 to 200 characters), ignoring case; title matches first, then the most recently updated (D70). `GET /hubs/:hubId/search`.',
    input: z.strictObject(searchFields),
    annotations: read,
  },
  claim_item: {
    title: 'Claim an item',
    description:
      'Sets the actor attribute to you and the date attribute to the server clock plus `duration`, if the claim is free, expired, or already yours (D68). A patch with a condition: when someone else holds a live claim, nothing is written and the answer is 412 `precondition_failed` with the item.',
    input: z.strictObject({ ...claimFields, ...claimDuration, ...writeFields }),
    annotations: write(true, false),
  },
  renew_claim: {
    title: 'Renew a claim',
    description:
      "Moves your claim's date to the server clock plus `duration`, if the claim is yours (D68); otherwise 412 `precondition_failed` with the item.",
    input: z.strictObject({ ...claimFields, ...claimDuration, ...writeFields }),
    annotations: write(true, false),
  },
  release_claim: {
    title: 'Release a claim',
    description:
      'Clears both claim attributes, if the claim is yours (D68); otherwise 412 `precondition_failed` with the item.',
    input: z.strictObject({ ...claimFields, ...writeFields }),
    annotations: write(true, false),
  },
} as const satisfies Record<McpToolName, McpToolContract>
