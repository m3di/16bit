# Architecture

This is the target design. M0 builds a thin slice of it; the "M0 scope" notes say which parts.

## Repository layout

```
packages/core     shared types, attribute type contracts, block registry, query shape
apps/api          HTTP API, WebSocket, MCP server, migrations, seed scripts
apps/web          Vue dashboard
e2e               Playwright tests
design/mockups    reference screens from the design phase (not shipped)
docs              product, decisions, architecture, design, roadmap, workflow
```

`packages/core` has no runtime dependencies on Node or the browser. Both apps import it. A change to its public contracts is gated on the maintainer.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict |
| Monorepo | pnpm workspaces |
| Frontend | Vue 3, Vite, Tailwind, Material Symbols |
| Frontend libraries (later milestones) | a headless primitives library, Tiptap for rich text, ECharts for charts, TanStack Virtual for long lists |
| Backend | Node, Fastify, Kysely, Zod |
| Database | Postgres |
| Real time | WebSocket, fed by Postgres `LISTEN/NOTIFY` |
| Tests | Vitest for unit tests, Playwright for end-to-end |
| Lint and format | ESLint and Prettier |

Use the current stable release of each when scaffolding, pin it, and read its current documentation. If one of these choices turns out to be a poor fit, raise it as a `needs-human` issue instead of swapping it quietly.

## Data model

Every table carries `workspace_id` as the leading column of its primary key and indexes. Row-level security is added in M1.

```sql
workspace        (id, name, created_at, next_revision_seq)
principal        (workspace_id, id, kind,           -- 'user' | 'agent'
                  name, workspace_role)
folder           (workspace_id, id, hub_id, parent_id,   -- hub: parent_id is null, hub_id = id
                  name, color, id_prefix, item_count, version, next_seq)
attribute        (workspace_id, id, hub_id, name, type, config jsonb, indexed bool)
folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position, required)
item             (workspace_id, id, hub_id, folder_id, seq_id,
                  values jsonb, version bigint, updated_at, updated_by)
item_index       (workspace_id, attribute_id, item_id, num, txt, ts)   -- derived
link             (workspace_id, from_item, attribute_id, to_item)
view             (workspace_id, id, hub_id, folder_id, tree jsonb, version)
revision         (workspace_id, seq bigint, item_id, version, patch jsonb, actor, cause, at)
comment          (workspace_id, id, item_id, parent_id, author, body jsonb, at)
document         (workspace_id, item_id, attribute_id, content jsonb, version)
hub_grant        (workspace_id, hub_id, principal_id, hub_role)
folder_grant     (workspace_id, folder_id, principal_id)
```

- `item.values` is keyed by attribute ID.
- `item_index` is written in the same transaction as the item, only for attributes with `indexed = true`.
- `revision.seq` increases per workspace. It is taken from `workspace.next_revision_seq` in the write transaction. A client asks for everything after a sequence number.
- `item.seq_id` is taken from the hub's `folder.next_seq` in the item insert transaction. Numbers are never reused.
- `attribute.hub_id` must be a hub, and `folder_attribute` joins a folder and an attribute from the same hub. Both are enforced with composite foreign keys (D10).
- `folder.item_count` on a hub is a counter kept in the write transaction, so the main dashboard never counts items.

**M0 scope:** `workspace`, `principal`, `folder`, `attribute`, `folder_attribute`, `item`, `revision`. No `item_index` yet; M0 lists items by folder with cursor paging and sorts by update time.

## Writes

```sql
UPDATE item
SET values = values || $patch, version = version + 1, updated_at = now(), updated_by = $actor
WHERE workspace_id = $1 AND id = $2 AND version = $3
RETURNING version;
```

Zero rows means a conflict: respond with HTTP 409 and the current item. Each write carries a client mutation ID so a retry is safe. The same transaction appends to `revision` and issues `NOTIFY` with the workspace and sequence number.

Validation happens before the transaction, using the type contracts in `packages/core` against the folder's attributes.

## Type contract

Each attribute type implements the same interface in `packages/core`:

1. JSON shape and validation
2. index projection (number, text, timestamp, or none)
3. filter operators
4. sort key and group buckets
5. summary functions
6. agent form: a JSON Schema fragment and a plain-text rendering

Rendering (cell and editor components) lives in `apps/web`, registered against the same type names.

**M0 scope:** text, number, boolean, date, select.

## Query shape

```json
{ "from": "folder_id", "where": { "and": [] }, "sort": [], "fields": [],
  "expand": {}, "group": null, "measures": [], "limit": 50, "cursor": null }
```

Rules: indexed attributes only for filter and sort, one level of expansion, a required limit, cursor paging.

## API

| Read form | Endpoint (v1) | Milestone |
|---|---|---|
| Describe | `GET /v1/hubs/:hub` | M0 (folders and attributes) |
| Get | `GET /v1/items/:id`, `POST /v1/items/get` | M0 |
| Query | `POST /v1/query` | M0 (by folder), M1 (filters) |
| Aggregate | `POST /v1/aggregate` | M4 |
| View data | `GET /v1/views/:id/data` | M4 |
| Search | `GET /v1/search` | M6 |
| Changes | `GET /v1/changes?after=seq` | M3 |
| Digest | `GET /v1/views/:id/digest` | M5 |

Writes: `POST /v1/items`, `PATCH /v1/items/:id` (with expected version), `DELETE /v1/items/:id`.

**M0 routes.** Every route except `/health` is scoped to a workspace: `/v1/workspaces/:workspaceId/...`, so the table's `/v1/items/:id` is `/v1/workspaces/:workspaceId/items/:id`. `GET /v1/workspaces` and `GET /v1/workspaces/:workspaceId/hubs` list what the caller can see. `DELETE` takes the expected version as `?version=`. Request and response shapes are in `packages/core/src/api.ts`. A stale version returns 409 `{ error: "conflict", message, current: Item }`. A revision's `patch` is `{ op: "create", folderId, values }`, `{ op: "update", values }`, or `{ op: "delete" }`. Not yet in M0: client mutation IDs and `POST /v1/items/get`.

**M0 auth:** a single development API key from the environment, sent as a bearer token, mapped to a seeded owner. Real authentication, sessions, and agent keys arrive in M1.

## Client data layer (from M3)

A normalised store keyed by item ID sits between the server and every component. Views hold ordered ID windows, not item copies. Writes are optimistic: applied locally, sent with a mutation ID, and rolled back if rejected. The client subscribes per folder over WebSocket, applies item changes to the store, and refetches aggregates when a folder's sequence moves.

**M0 scope:** plain fetch with an optimistic edit and rollback on 409 in the item panel. No WebSocket.

## Local development

- `docker compose up -d db` starts Postgres.
- `pnpm dev` runs migrations, then the API and the web dev server.
- `pnpm seed` loads a demo workspace.
- `pnpm seed:build-hub` imports this repository's GitHub issues into a local "Build" hub.
- `docker compose up --build` runs the whole stack from the container image: Postgres, a one-shot migration service, then the app serving the API and the built dashboard on one port. The browser has no key in M0, so this stack sets `DEV_ANONYMOUS_AS_OWNER=true` (requests without an `Authorization` header act as the dev owner, as through the Vite dev proxy) and publishes the port on 127.0.0.1 only. The API refuses to start with that flag on a non-loopback `HOST` unless `DEV_ANONYMOUS_ALLOW_NONLOCAL=1` is also set, which compose sets because the container binds 0.0.0.0 behind the loopback-only port (D41). It goes away with real auth in M1.
- `.env.example` documents every variable.

It must also run without Docker for anyone who has Postgres installed, by pointing `DATABASE_URL` at it.

## CI

On every pull request and on `main`: install, lint, typecheck, unit tests, build, then end-to-end tests with a Postgres service container. A parallel job builds the container image (never pushed) and smoke-tests it with `docker compose up`. M0 uses GitHub-hosted runners only. End-to-end tests are written so they can be sharded across runners later.

## Deployment target (M7)

One image, built from `main`, pushed to the in-cluster registry. A migration job runs before rollout. Backend pods are stateless and scale horizontally; WebSocket fan-out works across pods because each pod listens to Postgres. Self-hosted runners handle builds and deploys from `main` only.
