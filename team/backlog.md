# Sprint 0 backlog: first look

The initial plan for M0. During kickoff each entry becomes a GitHub issue; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** a green pipeline, the app running locally with a dashboard and a table of items, and the team's own issues visible inside a local "Build" hub.

---

## M0-01 Scaffold the monorepo
- **Role:** infra
- **Depends on:** nothing
- **Acceptance:** pnpm workspace with `packages/core`, `apps/api`, `apps/web`, and `e2e`. TypeScript strict. ESLint and Prettier configured at the root. Vitest runs one placeholder test per package. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass. `.gitignore` covers `.worktrees/`, `node_modules`, build output, and `.env`.

## M0-02 CI pipeline and branch protection
- **Role:** infra
- **Depends on:** M0-01
- **Gate:** needs-human (repository settings)
- **Acceptance:** a GitHub Actions workflow on pull requests and `main` runs install, lint, typecheck, unit tests, and build on GitHub-hosted runners, with dependency caching. Branch protection on `main` requires those checks, requires linear history, and blocks force pushes.

## M0-03 Local environment
- **Role:** infra
- **Depends on:** M0-01
- **Acceptance:** `docker compose up -d db` starts Postgres. `pnpm dev` runs migrations, the API, and the web dev server together. `.env.example` documents every variable. Works with a non-Docker Postgres through `DATABASE_URL`.

## M0-04 Core contracts, first cut
- **Role:** backend
- **Depends on:** M0-01
- **Gate:** needs-human (`packages/core` contracts)
- **Acceptance:** `packages/core` exports the entity types (workspace, principal, folder, attribute, item), the attribute type contract interface, and implementations for text, number, boolean, date, and select with validation and unit tests. Exports `validateItemValues(folderAttributes, values)`.

## M0-05 Schema and migrations
- **Role:** backend
- **Depends on:** M0-03
- **Gate:** needs-human (migration)
- **Acceptance:** a migration tool is set up. The first migration creates `workspace`, `principal`, `folder`, `attribute`, `folder_attribute`, `item`, and `revision` as described in `docs/ARCHITECTURE.md`, with `workspace_id` leading every key. A test applies migrations to an empty database.

## M0-06 Items API
- **Role:** backend
- **Depends on:** M0-04, M0-05
- **Acceptance:** endpoints for health, listing workspaces and hubs (with item counts), describing a hub (folders and attributes), listing a folder's items with cursor paging, and creating, reading, patching, and deleting an item. Values are validated with `packages/core`. A patch with a stale version returns 409 with the current item. Every write appends to `revision` and maintains the hub's item count. Bearer token auth using the development key. Unit and integration tests cover the conflict path.

## M0-07 Demo seed
- **Role:** backend
- **Depends on:** M0-06
- **Acceptance:** `pnpm seed` creates two workspaces with several hubs of different sizes, folders, attributes, and items, so every size-meter step appears on the dashboard. Running it twice does not duplicate data.

## M0-08 Design tokens and base components
- **Role:** design-system
- **Depends on:** M0-01
- **Acceptance:** light and dark tokens from `docs/DESIGN.md` as CSS variables wired into Tailwind, with a theme switch. Components: Button, Input, Select, StatusDot, Avatar (deterministic pixel sprite), SizeMeter, StateBlock (loading, empty, error, no permission). A local `/kit` route shows each component in both themes. Unit tests for Avatar determinism and SizeMeter thresholds.

## M0-09 Main dashboard
- **Role:** frontend
- **Depends on:** M0-06, M0-08
- **Acceptance:** the dashboard lists workspaces and their hubs as cards, matching `design/mockups/Home.dc.html` in structure and spacing, in both themes. Shows loading, empty, and error states. Only data the API provides in M0 is shown; the "waiting on you" and "recent" columns are left out, not faked.

## M0-10 Hub view with table and item panel
- **Role:** frontend
- **Depends on:** M0-09
- **Acceptance:** opening a hub shows its folders in a sidebar and the selected folder's items in a table with one column per attribute. Clicking a row opens an item panel showing fields, ID, and version. Editing a value saves optimistically and rolls back with a visible message on 409. A "new item" action creates an item. Empty folder state is designed.

## M0-11 Build hub import
- **Role:** backend
- **Depends on:** M0-06
- **Acceptance:** `pnpm seed:build-hub` reads this repository's issues through the `gh` CLI and upserts them into a "Build" hub: one item per issue with title, stage, role, milestone, and URL. Re-running updates existing items instead of duplicating them.

## M0-12 End-to-end smoke test in CI
- **Role:** qa
- **Depends on:** M0-02, M0-10
- **Acceptance:** Playwright is set up in `e2e`. CI starts Postgres as a service, migrates, seeds, starts the app, and runs: the dashboard shows the seeded hubs; an item created through the API appears in the table; editing in the panel persists; a stale patch through the API returns 409. The job is required on `main`. Tests are independent so they can be sharded later.

## M0-13 Container image and full-stack compose
- **Role:** infra
- **Depends on:** M0-10
- **Acceptance:** a multi-stage Dockerfile builds one image in which the API serves the built web app. `docker compose up` starts Postgres and the app, runs migrations, and serves the dashboard on one port. CI builds the image (without pushing).

## M0-14 First-look report
- **Role:** lead
- **Depends on:** all of the above
- **Acceptance:** `docs/reports/M0.md` covers what works, exact run commands, what was cut, open questions, and proposed changes to the workflow. `README.md` has the real quick start. The maintainer is told it is ready.
