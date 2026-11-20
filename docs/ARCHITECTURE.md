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
                  name, color, id_prefix, item_count, version, next_seq,
                  title_attribute_id)                    -- hub rows only (D50)
attribute        (workspace_id, id, hub_id, name, type, config jsonb, indexed bool, version)
deleted_hub      (workspace_id, id, deleted_at, deleted_by)   -- IDs of deleted hubs (D52)
deleted_attribute (workspace_id, id, hub_id, deleted_at, deleted_by) -- IDs of deleted attributes (#133)
folder_attribute (workspace_id, hub_id, folder_id, attribute_id, position, required)
item             (workspace_id, id, hub_id, folder_id, seq_id,
                  values jsonb, version bigint, updated_at, updated_by)
item_index       (workspace_id, attribute_id, item_id, ord, num, txt, ts)   -- derived; several rows per item for multi-valued types
link             (workspace_id, from_item, attribute_id, to_item)
view             (workspace_id, id, hub_id, folder_id, tree jsonb, version)
revision         (workspace_id, seq bigint, item_id, hub_id, version, patch jsonb, actor, cause, at,
                  client_mutation_id uuid)
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
- `revision.hub_id` is the item's hub, kept after the item and its hub are deleted, so row-level security can check history against hub grants (#44, #111).
- `revision.seq` increases per workspace. It is taken from `workspace.next_revision_seq` in the write transaction. A client asks for everything after a sequence number.
- `item.seq_id` is taken from the hub's `folder.next_seq` in the item insert transaction. Numbers are never reused.
- `revision.client_mutation_id` (migration `0012_mutation_ids`, D59) is the UUID a client sent with the write, or null. A partial unique index, `revision_client_mutation_key (workspace_id, actor, client_mutation_id) WHERE client_mutation_id IS NOT NULL`, makes it unique per workspace and actor, so a racing retry fails with 23505 instead of applying twice. The same migration adds `item_folder_number_idx (workspace_id, folder_id, seq_id DESC)` for the `number` order (D61).
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

- Type names are snake_case: `multi_select`, `url`, `actor`, `auto_id`, `rich_text`, `relation`. The `attribute.type` check constraint takes all of them from migration 0006 (#47).
- Multi-select, actor and relation values are lists of distinct IDs (option, principal, item). Actor and relation have `multiple` (actor off, relation on); with it off the list holds at most one. Caps: 100 options, 50 principals, 100 items. An empty list is stored as `null`. Each element is one `item_index` row; multi-select rows are in option order. Their filters are `in` ("has any of"), `not_in` ("has none of"), and the empty checks.
- Relation config is `{ targetHubId, crossHub = false, multiple = true }`. With `crossHub` off, `targetHubId` must be the attribute's own hub (D11), checked by `attributeSchema`. That linked items exist and are readable, and that actor IDs are principals of the workspace, is checked by the server.
- Relation writes (#47): each linked item must exist and sit in `targetHubId`. An ID that is new compared with the attribute's stored value must also be in a hub the writer can read (`can(…, 'hub.read')` with the writer's own hub grant); a stored one is kept even if the writer cannot read it, since they already see the ID. A missing new item and an unreadable one get the same 422 `invalid_values` error, so hidden items can't be probed. A stored ID whose item has since been deleted is dropped silently on patch (an attribute left empty is cleared), so a client can send back the value it read; the revision records the value as written. Targets are locked `FOR KEY SHARE` in the write transaction, which then replaces the item's `link` rows for each relation it touches. Deleting an item removes the links from and to it (cascade); relation values in other items keep the ID, and readers treat an ID with no link as gone.
- URL is an absolute http or https URL up to 2,048 characters.
- Auto ID is a positive integer the server writes on create: the item's `seqId`. `validateItemValues` refuses any client value for it with `read_only`, and it is never required on create.
- Rich text is ProseMirror JSON in `item.values`, limited to a closed node set, the one the shared editor from #48 uses: `doc`, `paragraph`, `heading` (level 3 or 4, since item titles take h1 and h2), `bulletList`, `orderedList` (`start`), `listItem` (a paragraph, then paragraphs or lists), `codeBlock` (plain text only), `hardBreak`, `text`, and the marks `bold`, `italic`, `code`, `link` (`href`: http, https or mailto). No other node, mark or attribute is accepted. Caps: 64 KiB of JSON (UTF-8) and 14 levels of nesting, which is lists six deep. A document with no text is empty. It indexes its plain text, filters with `contains` and `not_contains`, and renders as Markdown for agents.
- Actor, relation and rich text cannot be sorted: an ID or document order would look random. Sorting by a principal's or linked item's name needs the joined data and its own decision.
- Items have no title field. A hub names one `text` attribute as its title attribute (D50); the web app titles items with its value, and with none set, or an empty value, shows only the mono ID. Until that lands in M2, the web app uses the first `text` attribute of the item's folder by position (#50).

## Query shape

```json
{ "from": "folder_id", "where": { "and": [] }, "sort": [], "fields": [],
  "expand": ["attr_rel"], "group": null, "measures": [], "limit": 50, "cursor": null }
```

Rules: indexed attributes only for filter and sort, one level of expansion, a required limit, cursor paging.

**M1 scope (#45):** `from`, `where`, `sort`, `limit` (required, 1 to 200), `cursor`. Shapes are in `packages/core/src/query.ts`.

**Expand (#47):** `expand` is a list of up to 3 relation attributes shown on the `from` folder (indexing not needed: it reads `link`). The response adds `linked: { [itemId]: { access: "read", item } | { access: "none" } }` with every item the page links to through them, one level deep. `none` is an item in a hub the caller cannot read; its values are never sent. `linked` holds at most 1,000 items (`MAX_LINKED_ITEMS`), the first by ID, and `linkedTruncated` says whether more were cut off; without the cap one page could pull in 200 x 3 x 100 = 60,000 items. If `linkedTruncated` is false, an ID in an expanded relation value with no `linked` entry no longer exists; if it is true, ask again with a lower `limit`. Without `expand`, the response has neither key.

**Expand on a single item (#73):** `GET /v1/workspaces/:workspaceId/items/:itemId?expand=a,b` takes the same list (comma-separated, repeated keys, or both; an empty `?expand=` is none) with the same rules, checked against the item's folder, and returns the item with `linked` and `linkedTruncated` added (`itemReadSchema`). A panel opened by direct link can then tell an item in a hub the caller cannot read (`{ access: "none" }`) from a deleted one (no entry). The item itself is a 404 when missing or hidden, before `expand` is checked against its folder.

- `where` is a tree of `{ and: [...] }`, `{ or: [...] }`, and conditions `{ attribute, op, value }`: at most 20 conditions, 3 levels deep. `op` must be one of the attribute type's `filterOperators`; `value` is checked with the type's value schema (number bounds excepted) and projected like a stored value. `in`/`not_in` take an array of up to 100; `is_empty`/`is_not_empty` take none. `contains`, `not_contains`, `starts_with` ignore case; `eq` on text is exact. The negative operators also match items with no value.
- `sort` is up to 3 `{ attribute, direction }`. Text sorts case-insensitively, select by option order. Empty values sort last in both directions, and ties end on the item ID. With no `sort`, items come newest update first.
- Only indexed attributes shown on the `from` folder can be filtered or sorted. Anything else is a 400 `invalid_request` whose `message` names the path, attribute, and operator, with every problem listed in `errors: [{ path, message }]`.
- The cursor holds the last row's sort values and ID, so it only fits the sort it came from.
- Plans (D20). With no `sort`, a page is an index scan on `item_folder_updated_idx` with a row-comparison cursor and no sort step; `apps/api/src/query.test.ts` checks this with EXPLAIN. With `order: "number"` (M3, D61), a page is an index scan on `item_folder_number_idx (workspace_id, folder_id, seq_id DESC)` with a cursor on the item number, and an `offset` window walks the same index. A `sort` on attributes is not index-backed: each page reads every item in the folder that passes `where`, looks up its sort values in `item_index`, and sorts them, so a page costs O(folder size). That is fine at M1 folder sizes. Index-backed attribute sorts need a different shape (for example a per-folder sort column) and their own decision.
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
| Changes | `GET /v1/workspaces/:workspaceId/changes?after=seq`, and the WebSocket `GET /v1/workspaces/:workspaceId/feed` (D57) | M3 |
| Digest | `GET /v1/views/:id/digest` | M5 |

Writes: `POST /v1/items`, `PATCH /v1/items/:id` (with expected version), `DELETE /v1/items/:id`.

**M0 routes.** Every route except `/health` is scoped to a workspace: `/v1/workspaces/:workspaceId/...`, so the table's `/v1/items/:id` is `/v1/workspaces/:workspaceId/items/:id`. `GET /v1/workspaces` and `GET /v1/workspaces/:workspaceId/hubs` list what the caller can see. `DELETE` takes the expected version as `?version=`. Request and response shapes are in `packages/core/src/api.ts`. A stale version returns 409 `{ error: "conflict", message, current: Item }`. A revision's `patch` is `{ op: "create", folderId, values }`, `{ op: "update", values }`, or `{ op: "delete" }`. Not yet in M0: client mutation IDs and `POST /v1/items/get`.

**Backlinks (#47):** `GET /v1/workspaces/:workspaceId/items/:itemId/backlinks?limit=&cursor=` pages the items linking to an item, ordered by linking item ID then attribute ID: `{ items: { attributeId, item }[], nextCursor, hidden }`. Only linking items the caller can read are listed. `hidden` counts links from the others, over all pages, up to 1,000 (`MAX_HIDDEN_BACKLINKS`); their IDs are never sent, since naming them would show that items exist in hubs that otherwise answer 404 (docs/ROLES.md). The item itself must be in a hub the caller can read, or it is a 404.

**M0 auth (retired in #51):** a single development API key from the environment, sent as a bearer token and mapped to a seeded owner, plus D41's anonymous dev owner. Both are gone; M1 auth below is the only way in.

**M1 auth:** people sign in at `POST /v1/auth/login` and get a session cookie (D42); `POST /v1/auth/logout`, invite acceptance under `/v1/auth/invites/:token`, and `GET /v1/me` (the account and its workspaces, or, for an agent key, its workspace and hub) are the only routes besides `/health` outside `/v1/workspaces/:workspaceId` (D46, an exception to D40). Agent keys are bearer tokens. Passwords are reset only by the installation operator through a CLI command. Every request runs its queries in a transaction that sets the principal and workspace with `SET LOCAL` for row-level security. Three operations happen before the caller has a principal in the workspace, so they go through narrow `SECURITY DEFINER` functions owned by the migration role, each returning only what auth needs: resolving an agent key's secret hash to its principal, workspace and hub; listing an account's memberships (workspace, principal, role) for `GET /v1/me`; and `redeem_invite(token_hash, account_id)`, which checks expiry and use, inserts the principal, marks the invite used, writes `access_log`, and returns only the workspace and principal. The app role has no other way to read across workspaces.

**M1 sign-in, sessions and invites (#41).** Shapes are in `packages/core/src/auth.ts`.

- `POST /v1/auth/login` takes `{ email, password }` and returns the same body as `GET /v1/me`. A wrong password and an unknown email get the same 401 and take the same time (an argon2id check against a dummy hash). Attempts are limited per email (10 per 15 minutes) and per client IP (100 per 15 minutes, shared with invite acceptance), counted before the password is checked; over the limit is 429 `rate_limited` with `Retry-After`. The limiter is in memory, per process.
- Passwords are argon2id (19 MiB, 2 passes, 1 lane) through Node's built-in `crypto.argon2`, stored as PHC strings. New passwords are 12 to 256 characters.
- The session cookie `sid` is `HttpOnly; SameSite=Lax; Path=/; Secure` (unless `COOKIE_SECURE=false`) and holds a random 256-bit token; `session.id_hash` is its SHA-256. A session ends 30 days after sign-in or after 7 days without a request; `last_seen_at` is written at most once a minute. Signing in always starts a new session and deletes the one the request came with.
- CSRF: a write (any method but GET, HEAD, OPTIONS) that carries the session cookie, and every sign-in, sign-out and invite acceptance, is refused with 403 `forbidden` if `Sec-Fetch-Site` is present and not `same-origin` or `none`, or, without it, if `Origin` is present and its host differs from `Host`. Requests with neither header are not from a browser page and pass. Bearer-authenticated requests are not checked.
- Request auth resolves, in order: a live session cookie, then a bearer token (an agent key, #42). Anything else is 401, except on the sign-in, sign-out and invite routes. A session cookie together with any `Authorization` header is 400 `invalid_request` (D49). Inside `/v1/workspaces/:workspaceId` the identity becomes the `can()` subject (`{ id, kind, workspaceRole }`) for that workspace, or 404. A session's principal is read through `account_memberships`.
- `POST /v1/workspaces/:workspaceId/invites` takes `{ workspaceRole, expiresInDays }` (1 to 30, default 7), checks `member.invite`, and returns the invite and its token once; only the token's SHA-256 is stored. It writes `invite.create` to `access_log`.
- `POST /v1/auth/invites/:token` takes either `{ name, email, password }` (creates the account and signs it in) or `{}` with a session (adds that account). It calls `redeem_invite`, which writes `member.join` to `access_log`. Unknown, used or expired is 404; an account already in the workspace is 409 `already_member`. An email that has an account is 409 `email_taken`, but only after the invite is found valid, so the endpoint can't be used to probe emails without one. When the development password is refused (`NODE_ENV=production` without `ALLOW_DEV_PASSWORD=1`), a new account with that password is 400 `invalid_request` before the invite is checked, and the invite stays unused.
- `account_memberships(account_id)` and `redeem_invite(token_hash, account_id)` are `SECURITY DEFINER` functions (migration `0004_auth_functions`) with `search_path` pinned and `EXECUTE` revoked from `PUBLIC`; migration `0008` grants `EXECUTE` to the app role.
- In the dashboard (#49): `/sign-in?next=<path>` signs in and returns to `next` (same-origin paths only), and `/invite/<token>` accepts an invite, either as a new account with a password or, signed in, as the current account. Invite links are `<origin>/invite/<token>`. Any 401 from a data route sends the reader to sign-in with the current page as `next`; a 403 shows the no-permission state and a 404 the not-found state. The Vite dev proxy only forwards `/v1`; it adds no credentials.

**Agent keys (#42).** `POST /v1/workspaces/:workspaceId/hubs/:hubId/agent-keys` takes `{ name, hubRole, expiresAt? }` and returns 201 `{ key: AgentKey, secret }`; the secret (`16b_` + 32 random bytes, base64url) is shown once and stored as its hex SHA-256. One transaction inserts the agent principal, its one `hub_grant`, the `agent_key` row and the `access_log` entry. `GET .../hubs/:hubId/agent-keys` pages a hub's keys newest first, revoked ones included. `POST /v1/workspaces/:workspaceId/agent-keys/:keyId/revoke` sets `revoked_at` (idempotent; the principal and grant stay). A bearer token starting with `16b_` resolves in the auth hook through `auth_agent_key(secret_hash)` (migration `0005_agent_key_lookup`, `SECURITY DEFINER` like the two in `0004`), which returns the workspace, principal, hub and role, plus the workspace and hub names, and nothing for revoked or expired keys (401). `GET /v1/me` with a key returns `{ kind: 'agent', principalId, workspace: { id, name }, hub: { id, name }, hubRole }` from that lookup alone. Shapes are in `packages/core/src/api.ts`; permissions are `key.create`, `key.list` and `key.revoke` in `can()`.

**Role matrix in the API (#43).** Every route inside `/v1/workspaces/:workspaceId` decides with `can()` from core, using the caller's principal and its own `hub_grant` on the hub in question (`apps/api/src/access.ts`). Hub, folder, item and query routes resolve the hub first. Without a grant they answer 404, the same body as a missing hub, folder or item, for owners and admins too (D45). A visible thing with too low a role answers 403. Shapes are in `packages/core/src/api.ts`.

- `GET /hubs/:hubId` (describe) carries the caller's effective `hubRole` too (#73), so a client can show read-only states before a 403.
- `GET /hubs` returns `{ access: 'granted', hubRole, ...Folder }` for hubs the caller holds a grant on (`hubRole` is the effective role). Owners and admins also get `{ access: 'none', workspaceId, id, name, color }` for the rest, with no item count.
- `POST /hubs` (owners and admins) creates a hub, and the creator gets `hub_admin` in the same transaction.
- `GET /members` pages the workspace's people by name. Agents and removed members are not listed, and agents get 403. `PATCH /members/:principalId { workspaceRole }` changes a role, and `DELETE /members/:principalId` removes a member. Both lock every owner row first (`FOR NO KEY UPDATE`), so the last owner always stays, then read the actor's role again: an actor demoted or removed while the owner lock waited gets 403, not a 404 from RLS hiding the target (#127). Every access change follows one lock order, written at the top of `apps/api/src/members.ts` (#92): principal rows, then grant, invite and key rows, then the actor's principal `FOR KEY SHARE`, then the workspace row (`next_access_seq`), then `access_log`. No access change holds a principal `FOR UPDATE` while it waits for the workspace row, except member removal, which clears `account_id` (a unique key) only after deleting the target's grants, and expires the target's invites only after that, so it sees invites created concurrently. Hub creation locks its creator `FOR SHARE` first, so a removal of the creator running at the same time either waits and then revokes the new hub's grant, or commits first and the creation gets 403. The creator's workspace role is checked again on that locked row, so a creator demoted below admin in the meantime gets 403 too. Grants are never deleted a second time after the principal update (#96). An access change whose actor is removed or demoted while it is in flight gets 403 when it appends to `access_log`, and rolls back.
- `PUT /hubs/:hubId/grants/:principalId { hubRole }` grants or changes a role, including self-grants by owners and admins. `DELETE` on the same path revokes and is idempotent. Agent grants only come and go with their keys, or with their hub when it is deleted (D52).
- Removing a member deactivates the principal rather than deleting it (migration `0007_principal_removed`), so history keeps its actor. One transaction deletes their hub grants, clears `principal.account_id` (so `account_memberships` stops returning the workspace and the account's sessions no longer reach it), sets `removed_at`, and then expires their unused invites. A later invite adds the account again as a new principal. Agent keys they created stay until revoked.
- Every access change (grant set or revoked, role change, member removal, the creator's grant on a new hub) is appended to `access_log` in the same transaction (D48), never to `revision`. A change to the same value writes nothing.
- The seeds make the dev owner `hub_admin` of every hub they create, so it sees them after signing in.

## Row-level security (#44)

Migration `0008_row_level_security` enables RLS on every workspace-scoped table; `account` and `session` stay outside (D46).

- The API connects with `DATABASE_URL` as a login role in the group `sixteenbit_app`, which owns nothing and has no `BYPASSRLS`. Migrations, seeds and the password-reset command connect with `MIGRATION_DATABASE_URL` as the owner of the tables, which RLS does not apply to (no `FORCE`). The API exits at startup if its role is a superuser, bypasses RLS, owns the tables, or is outside the group. `pnpm db:migrate` creates the login role from `DATABASE_URL` when it is missing (local and CI); in a deployment, create it yourself and give the migration job `MIGRATION_DATABASE_URL` only.
- Every request inside `/v1/workspaces/:workspaceId` runs in one transaction that first sets `app.workspace_id` and `app.principal_id` with `set_config(..., true)` (`SET LOCAL`); write paths join it (`apps/api/src/db/scope.ts`). Item writes check the caller's grant in that transaction and hold it `FOR SHARE`, so a concurrent revoke waits for the write. Without both settings, or with a principal that is not an active member of the workspace, every scoped table reads as empty and refuses writes.
- Policies follow `docs/ROLES.md` and `can()`, which still decides every action in the API:
  - Workspace isolation everywhere, and nothing at all for a principal that is not an active member.
  - `folder`, `attribute`, `folder_attribute`, `item` and `revision` need a hub grant, with the same effective role as `effectiveHubRole()` (editor or hub admin to write items); owners and admins also see every hub row, for the hub list. `item_index` and `link` follow their item (a link its source item).
  - People see the member list and the grants on hubs they can read; an agent sees only its own principal and grant, and no keys.
  - Only owners and admins change roles or remove members, and only of people. Only an owner changes, removes, makes or invites an owner (footnote 1). `principal.account_id` can only be cleared, and a removed member stays removed.
  - Grants on people change as `changeGrant()` says: owners on anyone, admins on anyone but an owner (footnote 1), a hub admin on anyone but themselves, an owner or an admin (footnote 3). An agent's grant is made with its key by an owner, an admin or the hub's hub admin, at most the creator's effective role on the hub (footnote 2). Owners and admins create and revoke any key, a hub admin the keys of their hub.
  - `invite` is owners' and admins' only, and an update can only end an invite. Only an owner ends an owner-role invite (footnote 1, migration `0010_invite_update_owner`), except when removing the invite's creator; the rule is in `WITH CHECK`, so an admin can still lock the row and gets an error, not a missing row. Ending an invite sets `expires_at` to `created_at`, not `now()`, so a redeem that started earlier and waited on the row finds it ended (#113, #130). `access_log` is read by owners and admins and appended to by the caller as itself, for an action it may take: owners and admins any, a hub admin `grant.*` and `key.*` on its hub.
  - `workspace.next_revision_seq` moves one step at a time, for callers who can write items somewhere; `next_access_seq` likewise, for owners, admins and hub admins.
  - Writes must name the caller as `updated_by`, `actor` or `created_by`. Column grants limit updates to what the API changes; `revision` and `access_log` are insert-only.
  - A revision's item must be in the revision's hub, so one hub can't write another's history or take its next version number. A delete revision is checked by the `revision_guard` trigger instead, because its item is already gone: no item with that ID, a create revision in that hub, and no delete revision yet. The item's `DELETE` runs before the delete revision on purpose: it cascades to links that other writers hold while they wait for the hub, folder or workspace row, so taking those rows first could deadlock.
- Rules that compare a row before and after an update (owners, `account_id`, removal, the counters) are `BEFORE UPDATE` triggers, `principal_guard` and `workspace_guard`, and the rule for delete revisions is the `BEFORE INSERT` trigger `revision_guard`. They skip roles RLS does not apply to (`row_security_active`), so migrations and seeds are unaffected.
- Policy helpers that read `principal` and `hub_grant` are `SECURITY DEFINER` (`rls_workspace_role()`, `rls_agent()`, `rls_hubs(min)`, `rls_can_change_grant(hub, target)`) and answer only about the caller in its own workspace. Two more serve relations: `lock_link_targets(ids)` is for callers who can write items somewhere; it locks each target `FOR KEY SHARE` and returns its hub only if the caller can read it, else null (a writer may keep a stored link to an item it can't read). `hidden_backlinks(item, cap)` counts links from items the caller can't read, without naming them.
- RLS guards against a missing filter or a wrong ID in API code, not against SQL injection: the app role can call `set_config` itself, so injected SQL could name another principal or workspace. Every query stays parameterised.
- Known trade-off: an `UPDATE` policy's `USING` decides which rows a caller may lock, as well as change. Write paths lock before they decide, so `item_update` lets anyone who can read an item lock it `FOR UPDATE` (viewers included), and `principal_update` lets hub admins lock any principal row (they lock a grant's target `FOR SHARE`). The change itself is still checked by `WITH CHECK` and the triggers. So a reader can delay writes to those rows, but only for as long as its own request's transaction, which ends with the request.
- The API checks its database role before it binds its port, waiting for Postgres if needed, so it never serves a request with a role RLS does not apply to.

## Schema writes (#111)

Migration `0009_schema_writes` opens folders and attributes to hub admins and adds hub deletion (D50, D51, D52).

- `folder.title_attribute_id` names the hub's title attribute (D50): hub rows only (`folder_title_hub_check`), an attribute of the same hub (composite foreign key), of type `text` (trigger `folder_title_check`; an attribute named as a title can't change type either). Deleting the attribute sets it to null.
- `attribute.version` starts at 0, like `folder.version`. Attribute writes check and bump it as item writes do. Changes to a folder's attributes (attach, detach, reorder, `required`) check and bump `folder.version` in the same transaction; the API does both.
- The API role may insert and delete `attribute` and `folder_attribute` rows, update `attribute (name, config, version)`, `folder_attribute (position, required)` and `folder (name, color, parent_id, title_attribute_id, version)`, and delete `folder` rows. Never an attribute's `type`, `hub_id` or `indexed` (D51). `USAGE` on the `public` schema is granted explicitly, so a schema without PUBLIC's default still works. Migrating down revokes it again, even where an operator had granted it by hand before; such an installation must grant it again.
- Policies: only an effective hub admin (`rls_hubs(4)`) writes a hub's `attribute` and `folder_attribute` rows, and creates or deletes folders with a parent. A new folder starts with `item_count` 0, `next_seq` 1 and `version` 0. A relation attribute targets its own hub, or, with `crossHub` on, a hub the caller can read (D11, docs/ROLES.md). Editors still pass `folder_update` for the item counters, so the `folder_guard` trigger refuses any other folder change from someone who isn't the hub's hub admin. `attribute_guard` refuses a change to a relation's `targetHubId` or `crossHub` (D51).
- Data rules that bind every role: a folder never moves under itself or a descendant (`folder_parent_check`, which takes the hub row `FOR NO KEY UPDATE` first so concurrent moves can't make a cycle); a new relation's target hub must exist and is locked `FOR KEY SHARE` until the attribute commits (`attribute_target_lock`), and a missing hub is refused with the policy's own `42501`, so a missing hub and a hidden one can't be told apart; a hub never takes the ID of a deleted one (`hub_id_check`, which first locks any hub row with that ID `FOR KEY SHARE`, so an insert racing `delete_hub` waits for it and then sees the tombstone); an attribute never takes the ID of a deleted one (`attribute_id_check`, the same lock on any attribute row with that ID, then a check of `deleted_attribute`), refused with `23505` for the API to answer 409 `id_taken`. `attribute_tombstone` (`AFTER DELETE` on `attribute`) records every deleted attribute, whoever deletes it, `delete_hub` included. A folder holding items, subfolders or attached attributes can't be deleted (foreign keys), so the API detaches attributes first.
- `delete_hub(hub_id, version)` is the only way to delete a hub row: `SECURITY DEFINER`, `search_path` pinned, `EXECUTE` for the API role only. For the caller set in the transaction, it takes the caller's principal `FOR SHARE`, the hub's grants and agent keys `FOR UPDATE`, then the hub row `FOR UPDATE`, and only then checks: the caller is an owner or admin with a grant on the hub, not an admin while an owner holds one (footnote 1), the hub's version is `p_version` (D8), the hub has no folders or items, and no relation in another hub targets it. It revokes the hub's agent keys (rows stay), deletes its grants, its `folder_attribute` rows and then its attributes, deletes the hub and records its ID in `deleted_hub`, then takes the workspace row and logs `key.revoke` per key, `grant.revoke` per grant and one `hub.delete` to `access_log`. Errors: `16B03` missing or hidden (404), `16B04` not empty (409 `not_empty`), `16B05` targeted by a relation (409 `in_use`), `16B06` stale version (409 `conflict`), `42501` not allowed (403).
- Lock order for schema writes, next to item writes (item rows, hub row, folder row, workspace row) and access changes (`apps/api/src/members.ts`): (1) the caller's own grant `FOR SHARE`; a cross-hub relation insert also locks the caller's grant on the target hub here, never after the insert, because `delete_hub(target)` holds the target's grants `FOR UPDATE` while it waits for the hub row that `attribute_target_lock` holds; (2) to move or delete a folder, the hub row `FOR NO KEY UPDATE` before the folder row, because item create and delete take the hub row and then the folder row; a folder delete checks for items while holding the hub row, so it never waits on an item row; (3) the folder, attribute or `folder_attribute` rows, then the workspace row if it logs. `folder_parent_check` also takes the hub row, but it fires after the folder row is locked, so it is only a backstop against cycles, not a way to keep this order.
- **Schema write API (#112).** Routes for the shapes in `packages/core/src/hub-settings.ts`, in `apps/api/src/schema-writes.ts`: `PATCH` and `DELETE /hubs/:hubId`, `GET /hubs/:hubId/grants`, `POST /hubs/:hubId/folders`, `PATCH` and `DELETE /folders/:folderId`, `PUT /folders/:folderId/attributes`, `POST /hubs/:hubId/attributes`, `PATCH` and `DELETE /attributes/:attributeId`. Each decides with `can()` (`hub.rename`, `hub.manageSchema`, `hub.delete`, `grant.list`, `relation.target`). `GET /hubs/:hubId/grants` lists agents' grants too, with `keyState` (`active`, `revoked` or `expired`, decided as `auth_agent_key()` does) since a grant outlives its key; people's entries have no `keyState` (#151). `GET /hubs/:hubId` returns the hub as `hubSchema`, with `titleAttributeId`, and attributes carry `version`. `PUT /folders/:folderId/attributes` answers with `requiredEmpty`, the number of items in the folder with no value for each required attribute (D51), and takes `dryRun` to get those counts without writing. `GET /attributes/:attributeId/usage` (`hub.manageSchema`, select and multi-select) counts the hub's items per option for the options editor, from `item_index` when the attribute is indexed and from `item.values` otherwise (#141). Removing options or an attribute strips the values from every item of the hub that holds one, with a new item version and a revision each, and replaces their `item_index` rows (a deleted attribute's `item_index` and `link` rows go with it). `DELETE /hubs/:hubId` calls `delete_hub()` inside a savepoint, so a stale version can answer 409 with the hub as it is now. A hub ID that a deleted hub had is 409 `id_taken` on `POST /hubs`.
- **Hub schema lock (#112, D55).** Item creates and patches take a transaction-scoped advisory lock per hub, shared, right after their grant and before they read the folder's attributes (`apps/api/src/schema-lock.ts`). Removing options or deleting an attribute takes it exclusive, right after the caller's grant and before the attribute row; a rename or a new option doesn't take it. Nothing takes it while holding a row lock, so it can't close a deadlock cycle. Lock order for schema writes, written at the top of `schema-writes.ts`: (1) own grant `FOR SHARE`, (2) the hub schema lock, (3) attribute rows, (4) stripped item rows in ID order, (5) the hub row, (6) folder rows in ID order, then `folder_attribute` rows, (7) the workspace row. Item writes keep their own order (grant, hub schema lock, item rows, hub row, folder row, workspace row). A removal updates every affected item in one statement and appends their revisions last in one batch (`appendRevisions` in `items.ts`): because `workspace_guard` moves `next_revision_seq` one step per UPDATE, the steps run server-side in one `DO` statement, so the workspace row is held for a few statements whatever the number of items. An item create that waited for the hub row while a folder delete removed its folder answers 404.
- History outlives a deleted hub (D52): `revision.hub_id` no longer references `folder`, and no one can hold a grant on a deleted hub, so `revision_read` hides it from everyone. `deleted_hub` keeps the ID from being reused, because hub IDs can come from the client. `deleted_attribute` does the same for attribute IDs, which revisions key values by (D51, #133). The API role cannot read either table.
- The API has one connection pool, `DATABASE_URL`, and never receives the owner's `MIGRATION_DATABASE_URL`: nothing in `apps/api/src/server.ts` reads it, compose gives the app service none (seed with `docker compose run --rm migrate node src/seed.ts --force`), and CI sets it only on the migrate and seed steps. Locally, `pnpm dev` and the API that `pnpm e2e` starts get it set to empty, so the `.env` they load can't bring it back (an env file never overrides a variable that is set). With the dev key gone (#51), no request needs to read across workspaces as the owner.
- A pooled connection that Postgres drops (a restart, `pg_terminate_backend`, a network drop) is logged and discarded, and the next query opens a new one; a query in flight on it fails as usual, and after a termination in flight the next query can still fail once on the dying connection (#107).

## Client data layer (from M3)

A normalised store keyed by item ID sits between the server and every component. Views hold ordered ID windows, not item copies. Writes are optimistic: applied locally, sent with a mutation ID, and rolled back if rejected. The client subscribes per hub over one WebSocket (D57), applies item changes to the store, and refetches what a change may have reordered (D58 to D61).

**M0 scope:** plain fetch with an optimistic edit and rollback on 409 in the item panel. No WebSocket.

## Local development

- `docker compose up -d db` starts Postgres.
- `pnpm dev` runs migrations, then the API and the web dev server.
- `pnpm seed` loads the demo workspaces, people with accounts in every workspace role (development password, `apps/api/src/dev-accounts.ts`), their hub grants (logged in `access_log`), one agent key whose secret it prints once, and a hub with every M1 attribute type (#51). Stage, Points and Due in the work hubs, and every sortable attribute in the Launch hub, are indexed, so the table can sort and filter by them; a re-run switches these on for attributes seeded unindexed before #73 and fills their `item_index` rows (#73). Launch also has Design refs, a relation into Design that crosses hubs (D11), so a link shows as "no access" to Mina and as the item to Leo; seeded items leave it empty, and a re-run adds it to databases seeded before it (#91). Each hub's first text attribute, and Title in the Build hub, is the hub's title attribute (D50). The seeds set it only on a hub with no title at version 0, one nobody has edited through the API: a hub they create gets it at version 0, a hub seeded before #120 gets it with a version bump, and a title a hub admin changed or cleared, or whose attribute was deleted, is left alone (`apps/api/src/seed-hub-title.ts`, #120).
- `pnpm seed:build-hub` imports this repository's GitHub issues into a local "Build" hub. Like `pnpm seed`, it skips the hub and attributes deleted through the API (`deleted_hub`, `deleted_attribute`, `apps/api/src/seed-tombstones.ts`, #143).
- `pnpm seed:large` (#173) creates the `large` workspace with the Large hub and one folder of 50,000 items, for the large-folder work (D61). It writes in chunks of 2,500 items, each one transaction with `createItem`'s invariants and lock order (`seq_id` and item counts, `item_index` and `link` rows, one create revision per item, values checked with core's `validateItemValues`), but with set-based inserts, and one NOTIFY per chunk carrying its last `seq`. Item IDs are fixed and skipped once in `revision`, so a re-run adds only what is missing (`apps/api/src/large-seed.ts`).
- `docker compose up --build` runs the whole stack from the container image: Postgres, a one-shot migration service, then the app serving the API and the built dashboard on one port. People sign in as in `pnpm dev`; the port is published on 127.0.0.1 only, since seeded accounts share a public password. Under `NODE_ENV=production` that password is refused at sign-in, when accepting an invite with a new account (400 `invalid_request`), and by `pnpm account:reset-password`, unless `ALLOW_DEV_PASSWORD=1`, which only this compose stack's `app` service sets. The `migrate` service doesn't, so `account:reset-password` run there still refuses the dev password. (Until #51 this stack let anonymous requests act as the dev owner, D41, now retired.)
- `.env.example` documents every variable.

It must also run without Docker for anyone who has Postgres installed, by pointing `MIGRATION_DATABASE_URL` and `DATABASE_URL` at it.

## CI

On every pull request and on `main`: install, lint, typecheck, unit tests, build, then end-to-end tests with a Postgres service container. A parallel job builds the container image (never pushed) and smoke-tests it with `docker compose up`. M0 uses GitHub-hosted runners only. End-to-end tests are written so they can be sharded across runners later.

## Deployment target (M7)

One image, built from `main`, pushed to the in-cluster registry. A migration job runs before rollout. Backend pods are stateless and scale horizontally; WebSocket fan-out works across pods because each pod listens to Postgres. Self-hosted runners handle builds and deploys from `main` only.
