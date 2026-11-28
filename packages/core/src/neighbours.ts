import { z } from 'zod'
import { seqSchema } from './api.ts'
import { idSchema, itemSchema } from './entities.ts'

// Neighbours (D67, #205): an item's local graph over the `link` table, bounded (D20).
// `GET /v1/workspaces/:workspaceId/items/:itemId/neighbours?depth=&direction=&attributes=&limit=`.
// Served from #206; also the `neighbours` MCP tool (mcp.ts).

export const MAX_NEIGHBOUR_DEPTH = 2
export const DEFAULT_NEIGHBOUR_NODES = 100
export const MAX_NEIGHBOUR_NODES = 500
/** Relation attributes one request may filter by. */
export const MAX_NEIGHBOUR_ATTRIBUTES = 20
/** Edges one response carries; past it the response is `truncated`. */
export const MAX_NEIGHBOUR_EDGES = 5_000
/** Most hidden items `hidden` counts, as for backlinks. */
export const MAX_HIDDEN_NEIGHBOURS = 1_000

/** `out` follows the item's own relation values, `in` the links to it, `both` either. */
export const NEIGHBOUR_DIRECTIONS = ['out', 'in', 'both'] as const
export type NeighbourDirection = (typeof NEIGHBOUR_DIRECTIONS)[number]

/** The fields of a neighbours request, as JSON (the MCP tool) and as a query string. */
export const neighbourFields = {
  depth: z.int().min(1).max(MAX_NEIGHBOUR_DEPTH).default(1),
  direction: z.enum(NEIGHBOUR_DIRECTIONS).default('both'),
  /** Relation attributes to follow, each once. Absent: every relation. */
  attributes: z
    .array(idSchema)
    .min(1)
    .max(MAX_NEIGHBOUR_ATTRIBUTES)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Each attribute can be named once',
    })
    .optional(),
  /** The node cap: neighbours returned besides the item itself. */
  limit: z.int().min(1).max(MAX_NEIGHBOUR_NODES).default(DEFAULT_NEIGHBOUR_NODES),
}

/**
 * Query string. `attributes` is comma-separated (`?attributes=a,b`). Each must be a relation
 * attribute the caller can read (400 otherwise, alike for missing and hidden ones). The item
 * itself is 404 when missing or hidden, before anything else is checked.
 */
export const neighboursQuerySchema = z.strictObject({
  depth: z.coerce.number().pipe(neighbourFields.depth.unwrap()).default(1),
  direction: neighbourFields.direction,
  attributes: z
    .string()
    .max(MAX_NEIGHBOUR_ATTRIBUTES * 65)
    .transform((s) => s.split(','))
    .pipe(neighbourFields.attributes.unwrap())
    .optional(),
  limit: z.coerce.number().pipe(neighbourFields.limit.unwrap()).default(DEFAULT_NEIGHBOUR_NODES),
})
export type NeighboursQuery = z.input<typeof neighboursQuerySchema>

/** One item of the graph, `depth` links away from the item asked about (`0`). */
export const neighbourNodeSchema = z.strictObject({
  depth: z.int().min(0).max(MAX_NEIGHBOUR_DEPTH),
  item: itemSchema,
})
export type NeighbourNode = z.infer<typeof neighbourNodeSchema>

/** `from` links to `to` through its relation attribute `attributeId`. */
export const neighbourEdgeSchema = z.strictObject({
  from: idSchema,
  attributeId: idSchema,
  to: idSchema,
})
export type NeighbourEdge = z.infer<typeof neighbourEdgeSchema>

/**
 * The answer, read in one snapshot as of `seq` (D58) under row-level security.
 *
 * - `nodes`: the item first (depth 0), then its neighbours breadth first, by depth and then
 *   item ID, at most `limit` besides the item. Each appears once, at its shortest depth.
 * - `edges`: every link between two listed nodes that the request follows, by `from`,
 *   `attributeId`, `to`. Both ends are always in `nodes`.
 * - `truncated`: the node cap or `MAX_NEIGHBOUR_EDGES` cut something off.
 * - `hidden`: how many distinct items the walk reached that the caller can't read, up to
 *   `MAX_HIDDEN_NEIGHBOURS`. They are never named or walked past, as for backlinks
 *   (docs/ROLES.md). A link to an item that is gone is skipped and not counted.
 */
export const neighboursSchema = z.strictObject({
  nodes: z
    .array(neighbourNodeSchema)
    .min(1)
    .max(MAX_NEIGHBOUR_NODES + 1),
  edges: z.array(neighbourEdgeSchema).max(MAX_NEIGHBOUR_EDGES),
  truncated: z.boolean(),
  hidden: z.int().min(0).max(MAX_HIDDEN_NEIGHBOURS),
  seq: seqSchema,
})
export type Neighbours = z.infer<typeof neighboursSchema>
