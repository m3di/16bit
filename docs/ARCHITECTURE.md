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

Every workspace-scoped table carries `workspace_id` as the leading column of its primary key and indexes. Row-level security is added in M1. The installation-level tables (`account`, `session`) are the only exceptions: they sit outside row-level security and are only read by the auth code (D46).

```sql
account          (id, email unique, password_hash, name, created_at)      -- installation-level (D46)
session          (id_hash, account_id, created_at, last_seen_at, expires_at) -- installation-level
workspace        (id, name, created_at, next_revision_seq, next_access_seq)
principal        (workspace_id, id, kind,           -- 'user' | 'agent'
                  name, workspace_role, account_id) -- account_id for users only
invite           (workspace_id, id, token_hash, workspace_role, created_by, created_at, expires_at, used_at)
agent_key        (workspace_id, principal_id, secret_hash, created_by, created_at,
                  expires_at, revoked_at)  -- one agent principal per key; no hub or role (D47)
access_log       (workspace_id, seq, actor, action, target, detail jsonb, at)       -- grants, roles, keys, members (D48)
folder           (workspace_id, id, hub_id, parent_id,   -- hub: parent_id is null, hub_id = id
                  name, color, id_prefix, item_count, version, next_seq)
attribute        (workspace_id, id, hub_id, name, type, config jsonb, indexed bool)
folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position, required)
item             (workspace_id, id, hub_id, folder_id, seq_id,
                  values jsonb, version bigint, updated_at, updated_by)
item_index       (workspace_id, attribute_id, item_id, ord, num, txt, ts)   -- derived; several rows per item for multi-valued types
link             (workspace_id, from_item, attribute_id, to_item)
view             (workspace_id, id, hub_id, folder_id, tree jsonb, version)
revision         (workspace_id, seq bigint, item_id, version, patch jsonb, actor, cause, at)
comment          (workspace_id, id, item_id, parent_id, author, body jsonb, at)
document         (workspace_id, item_id, attribute_id, content jsonb, version)
hub_grant        (workspace_id, hub_id, principal_id, hub_role)
folder_grant     (workspace_id, folder_id, principal_id)
```

- `item.values` is keyed by attribute ID.
- A person has one `account` and one `principal` per workspace they belong to. An agent key is a `principal` of kind `agent` with workspace role `member` and exactly one `hub_grant` (D47); `agent_key` only holds its secret hash and lifecycle.
- `item_index` is written in the same transaction as the item, only for attributes with `indexed = true`. Each attribute type's `project` returns a list of values, one row each, numbered by `ord`; a write replaces all of an item's rows for the attributes it touches. An empty value has no row. Sorting reads the `ord = 0` row.
- `agent_key` and `hub_grant` also carry `principal_kind`, a copy of `principal.kind` held in step by a `(workspace_id, principal_id, principal_kind)` foreign key. It lets the database refuse a key on a person, a second grant for an agent, and `hub_admin` for an agent (D28, D47). `account.email` is stored trimmed and lowercased, and `password_hash` must be an argon2id string.
- The only indexes on workspace-scoped tables that do not lead with `workspace_id` are the three lookups that run before a principal is known: `agent_key.secret_hash`, `invite.token_hash` (both unique), and `principal.account_id`.
- `access_log.seq` is taken from `workspace.next_access_seq` in the same transaction as the access change.
- `revision.seq` increases per workspace. It is taken from `workspace.next_revision_seq` in the write transaction. A client asks for everything after a sequence number.
- `item.seq_id` is taken from the hub's `folder.next_seq` in the item insert transaction. Numbers are never reused.
- `attribute.hub_id` must be a hub, and `folder_attribute` joins a folder and an attribute from the same hub. Both are enforced with composite foreign keys (D10).
- `folder.item_count` on a hub is a counter kept in the write transaction, so the main dashboard never counts items.

**M0 scope:** `workspace`, `principal`, `folder`, `attribute`, `folder_attribute`, `item`, `revision`. `item_index` arrives in M1 (#45).

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

**M1 scope (#46):** multi-select, URL, actor, auto ID, rich text, relation (D44). Summary functions are listed but computed only from M4. Besides the six parts, each type states `readOnly` and `sortable`.

- Type names are snake_case: `multi_select`, `url`, `actor`, `auto_id`, `rich_text`, `relation`. The `attribute.type` check constraint still lists the M0 types; a migration adds the rest.
- Multi-select, actor and relation values are lists of distinct IDs (option, principal, item). Actor and relation have `multiple` (actor off, relation on); with it off the list holds at most one. Caps: 100 options, 50 principals, 100 items. An empty list is stored as `null`. Each element is one `item_index` row; multi-select rows are in option order. Their filters are `in` ("has any of"), `not_in` ("has none of"), and the empty checks.
- Relation config is `{ targetHubId, crossHub = false, multiple = true }`. With `crossHub` off, `targetHubId` must be the attribute's own hub (D11), checked by `attributeSchema`. That linked items exist and are readable, and that actor IDs are principals of the workspace, is checked by the server.
- URL is an absolute http or https URL up to 2,048 characters.
- Auto ID is a positive integer the server writes on create: the item's `seqId`. `validateItemValues` refuses any client value for it with `read_only`, and it is never required on create.
- Rich text is ProseMirror JSON in `item.values`, limited to a closed node set, the one the shared editor from #48 uses: `doc`, `paragraph`, `heading` (level 3 or 4, since item titles take h1 and h2), `bulletList`, `orderedList` (`start`), `listItem` (a paragraph, then paragraphs or lists), `codeBlock` (plain text only), `hardBreak`, `text`, and the marks `bold`, `italic`, `code`, `link` (`href`: http, https or mailto). No other node, mark or attribute is accepted. Caps: 64 KiB of JSON (UTF-8) and 14 levels of nesting, which is lists six deep. A document with no text is empty. It indexes its plain text, filters with `contains` and `not_contains`, and renders as Markdown for agents.
- Actor, relation and rich text cannot be sorted: an ID or document order would look random. Sorting by a principal's or linked item's name needs the joined data and its own decision.

## Query shape

```json
{ "from": "folder_id", "where": { "and": [] }, "sort": [], "fields": [],
  "expand": {}, "group": null, "measures": [], "limit": 50, "cursor": null }
```

Rules: indexed attributes only for filter and sort, one level of expansion, a required limit, cursor paging.

**M1 scope (#45):** `from`, `where`, `sort`, `limit` (required, 1 to 200), `cursor`. Shapes are in `packages/core/src/query.ts`.

- `where` is a tree of `{ and: [...] }`, `{ or: [...] }`, and conditions `{ attribute, op, value }`: at most 20 conditions, 3 levels deep. `op` must be one of the attribute type's `filterOperators`; `value` is checked with the type's value schema (number bounds excepted) and projected like a stored value. `in`/`not_in` take an array of up to 100; `is_empty`/`is_not_empty` take none. `contains`, `not_contains`, `starts_with` ignore case; `eq` on text is exact. The negative operators also match items with no value.
- `sort` is up to 3 `{ attribute, direction }`. Text sorts case-insensitively, select by option order. Empty values sort last in both directions, and ties end on the item ID. With no `sort`, items come newest update first.
- Only indexed attributes shown on the `from` folder can be filtered or sorted. Anything else is a 400 `invalid_request` whose `message` names the path, attribute, and operator, with every problem listed in `errors: [{ path, message }]`.
- The cursor holds the last row's sort values and ID, so it only fits the sort it came from.
- Plans (D20). With no `sort`, a page is an index scan on `item_folder_updated_idx` with a row-comparison cursor and no sort step; `apps/api/src/query.test.ts` checks this with EXPLAIN. A `sort` on attributes is not index-backed: each page reads every item in the folder that passes `where`, looks up its sort values in `item_index`, and sorts them, so a page costs O(folder size). That is fine at M1 folder sizes. Index-backed attribute sorts need a different shape (for example a per-folder sort column) and their own decision.
- A select value whose option was deleted still sorts (after every option), but cannot be filtered on: `eq`, `neq`, `in`, and `not_in` operands are checked against the current options and reject it as an unknown option. `is_empty` and `is_not_empty` still see it.

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

**M1 auth:** people sign in at `POST /v1/auth/login` and get a session cookie (D42); `POST /v1/auth/logout`, invite acceptance under `/v1/auth/invites/:token`, and `GET /v1/me` (the account and its workspaces, or, for an agent key, its workspace and hub) are the only routes besides `/health` outside `/v1/workspaces/:workspaceId` (D46, an exception to D40). Agent keys are bearer tokens. Passwords are reset only by the installation operator through a CLI command. Every request runs its queries in a transaction that sets the principal and workspace with `SET LOCAL` for row-level security. Three operations happen before the caller has a principal in the workspace, so they go through narrow `SECURITY DEFINER` functions owned by the migration role, each returning only what auth needs: resolving an agent key's secret hash to its principal, workspace and hub; listing an account's memberships (workspace, principal, role) for `GET /v1/me`; and `redeem_invite(token_hash, account_id)`, which checks expiry and use, inserts the principal, marks the invite used, writes `access_log`, and returns only the workspace and principal. The app role has no other way to read across workspaces.

**M1 sign-in, sessions and invites (#41).** Shapes are in `packages/core/src/auth.ts`.

- `POST /v1/auth/login` takes `{ email, password }` and returns the same body as `GET /v1/me`. A wrong password and an unknown email get the same 401 and take the same time (an argon2id check against a dummy hash). Attempts are limited per email (10 per 15 minutes) and per client IP (100 per 15 minutes, shared with invite acceptance), counted before the password is checked; over the limit is 429 `rate_limited` with `Retry-After`. The limiter is in memory, per process.
- Passwords are argon2id (19 MiB, 2 passes, 1 lane) through Node's built-in `crypto.argon2`, stored as PHC strings. New passwords are 12 to 256 characters.
- The session cookie `sid` is `HttpOnly; SameSite=Lax; Path=/; Secure` (unless `COOKIE_SECURE=false`) and holds a random 256-bit token; `session.id_hash` is its SHA-256. A session ends 30 days after sign-in or after 7 days without a request; `last_seen_at` is written at most once a minute. Signing in always starts a new session and deletes the one the request came with.
- CSRF: a write (any method but GET, HEAD, OPTIONS) that carries the session cookie, and every sign-in, sign-out and invite acceptance, is refused with 403 `forbidden` if `Sec-Fetch-Site` is present and not `same-origin` or `none`, or, without it, if `Origin` is present and its host differs from `Host`. Requests with neither header are not from a browser page and pass. Bearer-authenticated requests are not checked.
- Request auth resolves, in order: a live session cookie, a bearer token (the dev key until #51; agent keys from #42), then the anonymous dev owner if D41's flag is on. Inside `/v1/workspaces/:workspaceId` the identity becomes the `can()` subject (`{ id, kind, workspaceRole }`) for that workspace, or 404. A session's principal is read through `account_memberships`.
- `POST /v1/workspaces/:workspaceId/invites` takes `{ workspaceRole, expiresInDays }` (1 to 30, default 7), checks `member.invite`, and returns the invite and its token once; only the token's SHA-256 is stored. It writes `invite.create` to `access_log`.
- `POST /v1/auth/invites/:token` takes either `{ name, email, password }` (creates the account and signs it in) or `{}` with a session (adds that account). It calls `redeem_invite`, which writes `member.join` to `access_log`. Unknown, used or expired is 404; an account already in the workspace is 409 `already_member`. An email that has an account is 409 `email_taken`, but only after the invite is found valid, so the endpoint can't be used to probe emails without one.
- `account_memberships(account_id)` and `redeem_invite(token_hash, account_id)` are `SECURITY DEFINER` functions (migration `0004_auth_functions`) with `search_path` pinned and `EXECUTE` revoked from `PUBLIC`; #44 grants `EXECUTE` to the app role.
- In the dashboard (#49): `/sign-in?next=<path>` signs in and returns to `next` (same-origin paths only), and `/invite/<token>` accepts an invite, either as a new account with a password or, signed in, as the current account. Invite links are `<origin>/invite/<token>`. Any 401 from a data route sends the reader to sign-in with the current page as `next`; a 403 shows the no-permission state and a 404 the not-found state. Until #51 the Vite proxy still adds the development key, so the dashboard loads without signing in and `/v1/me` answers 401 to the key alone.

**Agent keys (#42).** `POST /v1/workspaces/:workspaceId/hubs/:hubId/agent-keys` takes `{ name, hubRole, expiresAt? }` and returns 201 `{ key: AgentKey, secret }`; the secret (`16b_` + 32 random bytes, base64url) is shown once and stored as its hex SHA-256. One transaction inserts the agent principal, its one `hub_grant`, the `agent_key` row and the `access_log` entry. `GET .../hubs/:hubId/agent-keys` pages a hub's keys newest first, revoked ones included. `POST /v1/workspaces/:workspaceId/agent-keys/:keyId/revoke` sets `revoked_at` (idempotent; the principal and grant stay). A bearer token starting with `16b_` resolves in the auth hook through `auth_agent_key(secret_hash)` (migration `0005_agent_key_lookup`, `SECURITY DEFINER` like the two in `0004`), which returns the workspace, principal, hub and role, plus the workspace and hub names, and nothing for revoked or expired keys (401). `GET /v1/me` with a key returns `{ kind: 'agent', principalId, workspace: { id, name }, hub: { id, name }, hubRole }` from that lookup alone. Shapes are in `packages/core/src/api.ts`; permissions are `key.create`, `key.list` and `key.revoke` in `can()`. Until #43, agents are held to their hub and role on every item route, and people are not yet checked against hub grants there.

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
