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
| D18 | Every block designs four states: loading, empty, error, no permission. | Nothing on the presentation surface is ever undesigned. |

## API

| # | Decision | Reason |
|---|---|---|
| D19 | No GraphQL. One JSON query shape, the same filter tree that views use. | Query cost stays predictable and cacheable. |
| D20 | Queries are bounded: indexed attributes only, one level of relation expansion, a required limit, cursor paging. | Every read maps to a known plan. |
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
| D48 | Access changes (grants, role changes, member removal, keys created or revoked) go to an append-only `access_log`, separate from the item `revision` log. | Self-grants by owners and admins stay visible without mixing access history into item history. |
| D49 | A request carrying both a session cookie and an `Authorization` header is refused with 400, whatever the header holds and whether or not the session is live. | Ambiguous credentials would let an agent key silently act with a person's rights, against D28, and would log writes under the wrong principal. Decided during M1 (#42). |
| D50 | Each hub names one of its `text` attributes as the item title (`title_attribute_id` on the hub's folder row). With none set, or an empty value, an item shows only its mono ID. Hub admins change it in hub settings. | Items need a title on the item page and in links without adding a column outside the attribute model. Replaces the M1 stopgap of "first text attribute by position". Decided for M2. |
| D51 | An attribute's type is fixed once created. Its name, options and required flag can change. Removing an option or an attribute that items use shows how many items are affected and needs confirmation. To change a type, add a new attribute. | No conversion rules per pair of types, and no value is silently dropped. Decided for M2. |
| D52 | A folder or hub can be deleted only when it holds no items and no folders. | Nothing is lost in one click; deleting data stays an explicit act on items. Decided for M2. |
| D53 | Editing root views waits for blocks in M4. M2 settings cover members, invites, hub access, agent keys, folders and attributes. | A view is a tree of blocks, which do not exist before M4. Decided for M2. |
