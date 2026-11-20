# Decisions

Decisions made before the build started. Each has a short reason. To change one, open an issue labelled `needs-human` and wait for the maintainer.

## Data model

| # | Decision | Reason |
|---|---|---|
| D1 | Postgres is the only required service and the single source of truth. | One thing to run, back up, and reason about. Caches and replicas are later performance work. |
| D2 | Hierarchy is workspace, hub, folder, item. A hub is a folder with no parent. | The hub is the unit of UI and of permissions. |
| D3 | Every folder and item stores its `hub_id`. | Isolation and permission checks become one indexed comparison, with no tree walk. |
| D4 | An item lives in exactly one folder. | One home per fact. Other placements are views or relations. |
| D5 | Item values are one JSONB column keyed by attribute ID. | A read is one row and a version check covers the whole item. Renaming an attribute costs nothing. |
| D6 | A derived `item_index` table holds typed copies of values for attributes marked "filter and sort". | Filtering and sorting stay indexed without creating an index per attribute. |
| D7 | Relations are stored in a `link` table. | Backlinks and clean deletes. This is also the graph. |
| D8 | Every item has an integer `version`. Writes send the expected version and get a conflict if it moved. | Prevents silent overwrites between people and agents. |
| D9 | An append-only `revision` log with a per-workspace sequence number records every write. | History, undo, the real-time feed, and audit come from one table. |
| D10 | Attributes belong to a hub, not the workspace. | A schema change in one hub cannot affect another. |
| D11 | Relations across hubs are off by default and enabled per attribute. | They are the one place data can leak between hubs. |
| D12 | Attribute types are a closed set of 13: text, rich text, number, boolean, date, select, multi-select, relation, actor, file, URL, auto ID, rollup. | The parser can refuse anything else. Email, phone, percent, and currency are formats, not types. |
| D13 | Changing an attribute's type is a migration job, never an in-place edit. | Old values must not silently stop validating. |

## Views

| # | Decision | Reason |
|---|---|---|
| D14 | A view is a tree of blocks with a registry that states which children each block allows. | Composition is flexible and can never loop. |
| D15 | Version 1 has 17 block types: page, section, columns, tabs; heading, text, divider, image; table, list, board, chart, number; fields, document, comments, activity. | Enough to build real pages. More are added through the registry. |
| D16 | Anything an agent should be able to query is an item, never view content. | The data API stays the whole truth. |
| D17 | A view is stored as one JSONB document with its own version, and blocks have stable IDs. | One fetch, atomic validation, patch by block ID. |
| D18 | Every block designs four states: loading, empty, error, no permission. A block or page that opens one thing by ID designs a fifth, not found. | Nothing on the presentation surface is ever undesigned. "Not found" was added after M2, when the item page and settings opened things by ID (the maintainer's answer to the M2 report). |

## API

| # | Decision | Reason |
|---|---|---|
| D19 | No GraphQL. One JSON query shape, the same filter tree that views use. | Query cost stays predictable and cacheable. |
| D20 | Queries are bounded: indexed attributes only, one level of relation expansion, a required limit, cursor paging. The dashboard may also ask for a window by offset, up to 100,000, and for the total count (D61). | Every read maps to a known plan. |
| D21 | Read forms: describe, get, query, aggregate, view data, search, changes, digest. | Agents get ready-to-use shapes instead of assembling them. |
| D22 | The API is plain HTTP with JSON, mirrored as MCP tools. | Reaches nearly every model and framework. |
| D23 | Triggers are in scope (change feed and signed webhooks). An action or automation engine is not. | Agents are the "then that". |
| D24 | Triggers are evaluated from the log after commit, never inside the write. | Writes stay fast. |

## People, agents, and permissions

| # | Decision | Reason |
|---|---|---|
| D25 | People and agent keys are both principals and go through the same permission checks. | One model to secure. |
| D26 | Workspace roles: owner, admin, member, viewer, finance. Hub roles: hub admin, editor, commenter, viewer. | A workspace role sets what someone can do. Hub access sets where. |
| D27 | A hub grant is required to see anything in the hub. A folder grant can only narrow it. | Hubs are guarded against each other. |
| D28 | Agent keys are scoped to one hub and can never manage members or billing. | Limits the blast radius of a leaked or misled agent. |

## Stack and delivery

| # | Decision | Reason |
|---|---|---|
| D29 | TypeScript end to end, in a pnpm monorepo: `packages/core`, `apps/api`, `apps/web`. | Type contracts and the block registry run in both the browser and the server from one package. |
| D30 | Frontend: Vue 3, Vite, Tailwind, Material Symbols. | Maintainer's choice. |
| D31 | Backend: Node with a small HTTP framework, a typed SQL query builder, and schema validation shared with the frontend. | Dynamic filter queries need a builder, not an ORM. |
| D32 | Desktop first and fully responsive. No native mobile app for now. | Scope. |
| D33 | Trunk-based development. Deploy from `main`. | Short branches, always releasable. |
| D34 | One container image serves both the API and the built web app. Only backend pods scale. | Standard web app on Kubernetes. |
| D35 | CI runs lint, typecheck, unit tests, build, and end-to-end tests. Every major function has an end-to-end test. | A green pipeline means something. |
| D36 | Pull requests from forks never run on self-hosted runners. | That would execute a stranger's code inside the cluster. |

## Project

| # | Decision | Reason |
|---|---|---|
| D37 | Code is Apache 2.0. The name "16bit.info" and the logo are reserved. | Anyone may fork and sell under another name. Only the maintainer uses the name. |
| D38 | Public issues and pull requests are welcome. Only the maintainer merges contributions from outside the agent team. | Personal project with one owner. |
| D39 | Light theme first, with every colour a CSS variable so dark mode is a token swap. | Both themes from one design. |
| D40 | API routes are scoped by workspace in the path: `/v1/workspaces/:workspaceId/...`. | IDs are unique per workspace (keys lead with `workspace_id`), and the workspace is visible in links and logs. Decided during M0 (#6). |
| D41 | **Retired in M1 (#51).** Was, for M0 only: `DEV_ANONYMOUS_AS_OWNER=true` let API requests without an `Authorization` header act as the dev owner, so the dashboard served by the container image worked without a key in the browser, guarded to loopback hosts. Removed together with the M0 development key once people could sign in; every request now needs a session or an agent key. | The browser had no key in M0. Real auth (D42) replaced it. Approved by the maintainer (#13); retired as planned in M1. |
| D42 | People sign in with email and password, hashed with argon2id. Sessions are stored in Postgres and sent as an httpOnly cookie. Passwords are reset only by the installation operator through a CLI command; self-service reset waits for an email service. | No outside service (D1), simple to self-host, and no admin of one workspace can take over an account that also belongs to another. Decided for M1. |
| D43 | M1 is invite-only. Owners and admins add members or create one-time invites through the API. There is no public sign-up. | No abuse handling needed before there is a deployment. The UI comes with settings in M2. |
| D44 | M1 builds every attribute type except file and rollup (D12). Rich text is stored as a JSON document. File waits for a storage decision; rollup comes with aggregation (M4). | Keeps M1 to access and query; the two heavy types need their own design. |
| D45 | The role matrix is `docs/ROLES.md`. Hub grants bind owners and admins too: they may grant themselves access, recorded in the log, but see nothing inside a hub without a grant. Hidden resources return 404. | Hubs are guarded against everyone (D27), and leaked owner sessions don't expose every hub. |
| D46 | People have one installation-level `account` (email, password) and one `principal` per workspace. `account` and `session` sit outside row-level security. `/v1/auth/*` and `/v1/me` are the only routes besides `/health` not under a workspace (exception to D40). | One login for several workspaces. |
| D47 | Each agent key is its own principal of kind `agent`, workspace role `member`, with exactly one `hub_grant` (editor, commenter or viewer). The key row holds only the secret hash, expiry and revocation. Agents get no workspace actions. | Permission checks and row-level security treat agents and people the same way (D25, D28). |
| D48 | Access changes (grants, role changes, member removal, keys created or revoked, invites created or revoked) go to an append-only `access_log`, separate from the item `revision` log. | Self-grants by owners and admins stay visible without mixing access history into item history. |
| D49 | A request carrying both a session cookie and an `Authorization` header is refused with 400, whatever the header holds and whether or not the session is live. | Ambiguous credentials would let an agent key silently act with a person's rights, against D28, and would log writes under the wrong principal. Decided during M1 (#42). |
| D50 | Each hub names one of its `text` attributes as the item title (`title_attribute_id`, set only on hub rows). With none set, or an empty value, an item shows only its mono ID. Hub admins change it in hub settings. Removing the title attribute clears it. | Items need a title on the item page and in links without adding a column outside the attribute model. Replaces the M1 stopgap of "first text attribute by position". Decided for M2. |
| D51 | An attribute's type is fixed once created, and so are a relation's target hub and its cross-hub flag (D11). Its name and its select options can change, and so can whether a folder requires it (`folder_attribute.required`). Removing an option or an attribute that items use shows how many items are affected and needs confirmation. To change a type or target, add a new attribute. A folder may start requiring an attribute that existing items leave empty: settings shows how many, and those items stay valid. As today, an edit that does not touch the attribute succeeds, and a required value cannot be cleared once set. | No conversion rules per pair of types, no broken links, and no value silently dropped. Decided for M2 (#108). |
| D52 | A folder or hub can be deleted only when it holds no items and no folders. Deleting an empty hub revokes its agent keys (the key rows stay, revoked, as with any revocation), deletes every grant on it and its attributes, and logs the grant and key changes in `access_log`. It is refused while a relation attribute in another hub targets it. The owner or admin deleting it must hold a grant on it, and an admin is refused when an owner holds a grant on it (`docs/ROLES.md` footnote 1). One narrow `SECURITY DEFINER` function does the delete. The revision history of the hub's deleted items stays, readable by no one. | Nothing is lost in one click; deleting data stays an explicit act on items. Checking emptiness reads inside the hub, which needs a grant (D45). Decided for M2 (#108). |
| D53 | Editing root views waits for blocks in M4. M2 settings cover members, invites, hub access, agent keys, folders and attributes. | A view is a tree of blocks, which do not exist before M4. Decided for M2. |
| D54 | Folder grants that narrow a hub grant (D27) wait until after M2. Settings grant access per hub. | Folder grants need their own row-level security and UI; M2 stays on its exit criterion. Decided for M2 (#108). |
| D55 | Each hub has a schema lock: a transaction-scoped Postgres advisory lock keyed by workspace and hub (`apps/api/src/schema-lock.ts`). Item creates and patches take it shared, before they read the folder's attributes to validate. Removing select options or deleting an attribute takes it exclusive, before it locks the attribute row and strips values. Renames, new options and other schema writes don't take it, and neither do item deletes. While a removal runs, item creates and patches in that hub wait for it; shared holders never wait for each other, and other hubs are unaffected (a hash collision between two hubs only makes them wait). It costs one extra statement per item create or patch. | Without it, an item write that validated against the old options could commit a removed option, or a deleted attribute's value, after the strip. A row lock on `attribute` can't do this: under row-level security only hub admins may lock attribute rows. Decided by the maintainer for M2 (#112, PR #131). |
| D56 | A hub's ID prefix is unique in its workspace, ignoring case. Creating a hub with a prefix in use is a 409 `prefix_taken`. A deleted hub's prefix is free again, since nobody can read its history. | Two hubs showing `ENG-12` would make mono IDs ambiguous in links, comments and agent output. Decided for M3 (the maintainer's answer to the M2 report). |
| D57 | The change feed is one WebSocket per browser tab, `GET /v1/workspaces/:workspaceId/feed`, plus the same events over HTTP, `GET /v1/workspaces/:workspaceId/changes?after=&limit=`, for agents and for catching up. A browser authenticates with its session cookie, and the upgrade is refused unless `Origin` is the app's own; an agent uses its key in `Authorization`. A client subscribes per hub, not per folder, and filters by folder itself, so moved and deleted items need no lookup. | One connection carries every subscription, and the HTTP route lets agents read changes without holding a socket (D21, D23). |
| D58 | Feed events are read from `revision` under the subscriber's own identity, so row-level security decides what each socket sees, exactly as for a GET. An event carries the sequence number and the item as it is now (or that it is gone), not the patch; several revisions of one item in a batch collapse to the latest. Each process keeps one dedicated `LISTEN` connection, coalesces notifications for 50 ms, and runs one read per subscriber. A client resumes with the last sequence it saw; past 1,000 missed changes the server answers `resync` and the client reloads what it shows. Schema writes and access changes also notify: a hub event makes clients reload the hub's schema, and a lost grant ends that hub's subscription. The session or key is checked on every delivery and at least once a minute; when it ends, the socket closes. | No second permission model to keep in step with RLS. One read per subscriber per batch is fine for M3; fan-out at scale is M7's problem. |
| D59 | Every item write may carry a `clientMutationId` (a UUID), stored on its revision and unique per workspace and actor. A retry with the same ID applies nothing and answers as the first attempt did, with the item as it is now. The feed echoes the ID, so a client confirms its own optimistic write. | Safe retries after a dropped connection, and no flicker when a client's own change comes back. |
| D60 | The web app keeps one normalised store per workspace, keyed by item ID, built on Vue's `shallowReactive` with frozen item objects that are replaced, never mutated. No state library. Views hold ordered windows of IDs. Optimistic writes sit in a pending layer above server state and are dropped on rejection, which shows the 409 conflict as today. There is no offline queue: a write while disconnected fails with a message. | 50,000 deeply reactive items would be slow, and the store is small enough not to need Pinia. |
| D61 | Large folders render with `@tanstack/vue-virtual` and load in windows of 200 rows by offset, with the folder's total count sizing the scrollbar. A change in a loaded hub updates rows in place; a create, delete, or change to a sorted or filtered attribute refetches the visible window, debounced. Smooth means: after a jump anywhere in a 50,000-item folder, rows show within one second, scrolling has no main-thread task over 50 ms, and fewer than 100 rows are in the DOM. | Cursor paging cannot jump to the middle of a scrollbar. An index scan with an offset of 50,000 costs tens of milliseconds, inside D20's bounds. |
