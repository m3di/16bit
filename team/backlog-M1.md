# Sprint 1 backlog: data API and access

The initial plan for M1. Each entry became a GitHub issue during planning; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** people sign in, agent keys work, every request is checked against `docs/ROLES.md` in the API and again by row-level security, items can be filtered and sorted, the new attribute types and relations work end to end, and an end-to-end suite proves the role matrix.

**Decisions this plan rests on:** D42 (email and password, sessions in Postgres), D43 (invite-only), D44 (no file or rollup in M1), D45 (role matrix, strict hub grants).

---

## M1-01 Role matrix and permission function in core
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (`packages/core` contracts)
- **Acceptance:** `packages/core` exports the workspace and hub role enums, the agent-key roles, and one pure function such as `can(actor, action, scope)` that encodes every row of `docs/ROLES.md`, including the effective hub role cap, the admin-versus-owner rules, the hub admin "not above your own role" rule, and agent-key limits. A table-driven test covers every cell of the matrix. Nothing calls it yet.

## M1-02 Auth and access schema
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (migration)
- **Acceptance:** a new migration (never an edit to `0001`) adds credentials for people (email unique per installation, argon2id hash), `session`, `invite`, `agent_key` (hashed, one hub, role, optional expiry, revoked flag), and `hub_grant` as in `docs/ARCHITECTURE.md`, with `workspace_id` leading every key where the table is workspace-scoped. Tests apply it to an empty database and to one migrated with `0001`.

## M1-03 Sign-in, sessions and invites API
- **Role:** backend
- **Depends on:** M1-01, M1-02
- **Acceptance:** `POST /v1/auth/login`, `POST /v1/auth/logout` and `GET /v1/me`. Sessions are an httpOnly, SameSite=Lax cookie with idle and absolute expiry, rotated on login. Login is rate-limited and does not reveal whether an email exists. State-changing requests that use the cookie are protected against CSRF. Owners and admins create invites; accepting one sets a password and creates the membership. Admin password reset. Integration tests cover each path and its failures.

## M1-04 Agent keys API
- **Role:** backend
- **Depends on:** M1-01, M1-02
- **Acceptance:** owners, admins and that hub's hub admins create, list and revoke agent keys for a hub. The secret is shown once and stored hashed. The bearer key authenticates as the key's principal, limited to its one hub and role. Revoked or expired keys get 401. Tests cover scope, revocation and expiry.

## M1-05 Enforce the role matrix in the API
- **Role:** backend
- **Depends on:** M1-03, M1-04
- **Acceptance:** every existing and new route checks `can()` from core. Hidden hubs, folders and items return 404; forbidden actions on visible things return 403 (`docs/ROLES.md`). API for members (list, change role, remove) and hub grants (grant, change, revoke), following the matrix. Creating a hub makes the creator its hub admin. Self-grants by owners and admins are written to the revision log. The dev bearer key is removed from the API. Tests for each role against each route family.

## M1-06 Row-level security
- **Role:** backend
- **Depends on:** M1-05
- **Gate:** needs-human (migration, security)
- **Acceptance:** a migration enables RLS on every workspace-scoped table. The API connects as a role that does not own the tables and cannot bypass RLS, and sets the principal and workspace with `SET LOCAL` in each transaction. Policies enforce workspace isolation and hub grants for reads and writes. Tests run raw queries as the app role with a wrong or missing principal and show they return nothing or fail. Migrations run as the owner role. The CI and compose roles are updated.

## M1-07 Item index, filters and sorting
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (migration, `packages/core` contracts)
- **Acceptance:** a migration adds `item_index` (D6), written in the same transaction as the item for indexed attributes, with a backfill for existing items. The query endpoint accepts the `where` and `sort` shape from `docs/ARCHITECTURE.md` on indexed attributes only, with each type's filter operators from its core contract, a required limit and cursor paging (D19, D20). Unindexed or invalid filters give a 400 that names the problem. Tests cover each M0 type's operators and paging under sort.

## M1-08 New attribute types in core
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (`packages/core` contracts)
- **Acceptance:** core contracts for multi-select, URL, actor, auto ID, rich text (a JSON document with a small, closed node set) and relation (value shape and config, including the cross-hub flag from D11), each with validation, index projection, filter operators, sort and group keys, and agent form, plus unit tests. Auto ID is assigned by the server and read-only for clients.

## M1-09 Relations and the link table
- **Role:** backend
- **Depends on:** M1-07, M1-08
- **Gate:** needs-human (migration)
- **Acceptance:** a migration adds `link` (D7). Writes keep links in step with relation values in the same transaction. Cross-hub targets are rejected unless the attribute allows them (D11). Deleting an item removes its links. `expand` in the query endpoint follows one level of relations and returns linked items the caller can read, and a "no access" marker for those it can't. A backlinks read is available. Tests cover each rule, including the no-access case.

## M1-10 Shared components for new types and sign-in
- **Role:** design-system
- **Depends on:** nothing
- **Acceptance:** Checkbox, multi-select chips, a link-style URL display, an actor chip using PixelAvatar, a relation chip including its "no access" state, a basic rich text editor and viewer for the closed node set, and the sign-in form layout. Every component has all four states (D18), shows on `/kit` in both themes, and has unit tests. Uses tokens only.

## M1-11 Sign-in, session and access states in the web app
- **Role:** frontend
- **Depends on:** M1-03, M1-05, M1-10
- **Acceptance:** a sign-in page, sign-out, and redirect back after sign-in. An invite acceptance page that sets a password. 401 sends the user to sign-in; 403 and 404 show the designed no-permission and not-found states. The current user's name and avatar are shown in the shell. The Vite proxy no longer adds a key. Tests for each flow.

## M1-12 Cells and editors for the new types
- **Role:** frontend
- **Depends on:** M1-08, M1-09, M1-10
- **Acceptance:** table cells and panel editors for every M1 type, including a relation picker limited to items the user can read, and "no access" relation chips. Auto ID is read-only. Validation in the client uses core. Tests per type.

## M1-13 Seed people, grants and agent keys; retire D41
- **Role:** backend
- **Depends on:** M1-05
- **Acceptance:** `pnpm seed` creates people with known development passwords (documented, development only), roles that cover the matrix, hub grants, and one agent key whose secret is printed once. Seeded data includes items for every M1 type. `DEV_ANONYMOUS_AS_OWNER` and its guard are removed (D41 retired), and compose and CI are updated so the browser signs in. `pnpm seed:build-hub` keeps working.

## M1-14 Filters and sorting reach the web table
- **Role:** frontend
- **Depends on:** M1-07, M1-11
- **Acceptance:** column sorting in the hub table for indexed attributes, using the query endpoint. Presentation has no filter bars (PRODUCT.md), so filters are only exercised through the API in M1. Sorted paging keeps working. Tests.

## M1-15 Role matrix end-to-end suite
- **Role:** qa
- **Depends on:** M1-06, M1-11, M1-12, M1-13
- **Acceptance:** end-to-end tests with two people of different roles and one agent key, covering every row of `docs/ROLES.md` that M1 implements. Each test shows what is visible, what is allowed, and that forbidden actions fail with the right status in both the API and the browser. The suite runs in CI and is required on `main`.

## M1-16 Small review leftovers from M0
- **Role:** backend
- **Depends on:** nothing
- **Acceptance:** as written in #38. (Existing issue, moved into the milestone, not recreated.)

## M1-17 M1 report
- **Role:** lead
- **Depends on:** all of the above
- **Acceptance:** `docs/reports/M1.md` covering what works, exact run commands, what was cut, open questions and workflow changes. README updated. The maintainer is told it is ready.
