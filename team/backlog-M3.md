# Sprint 3 backlog: sync

The initial plan for M3. Each entry becomes a GitHub issue during planning; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** two browsers and one agent editing the same folder stay consistent without reloading, and a 50,000-item folder scrolls smoothly (the M3 exit criterion in `docs/ROADMAP.md`).

**Decisions this plan rests on:** D57 (feed transport: one WebSocket per tab plus an HTTP changes route, subscriptions per hub), D58 (events read under the subscriber's identity, item as it is now, resume and resync), D59 (client mutation IDs), D60 (the client store), D61 (virtual scrolling, offset windows, and what "smooth" means; amends D20). From the M2 report: D56 (unique hub ID prefixes), D18 reworded to five states, and #138.

## Answers to the M2 report

The maintainer asked the lead to decide all five questions:

1. **ID prefixes** are unique per workspace, ignoring case (D56, M3-10).
2. **The New hub dialog** stays as built.
3. **Table headers** stay 32px, on the 4px grid; `docs/DESIGN.md` already says so and the mockups' 30px is superseded.
4. **"What each role can do"** is built, generated from `can()` so it cannot drift from `docs/ROLES.md` (#138, M3-11).
5. **D18** now names a fifth state, not found, for anything opened by ID.

---

## M3-01 Sync contracts in core
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (`packages/core` contracts)
- **Acceptance:** `packages/core` exports: the feed protocol (client messages `subscribe`, `unsubscribe` with a hub ID and `after`; server messages `changes` with `{ seq, hubId, itemId, item | null, clientMutationId? }[]`, `hub` with the hub's version, `access_lost`, `resync`, `error`), the `GET /changes` request and response (paged by `after` and `limit`, up to 1,000), an optional `clientMutationId` on item create, patch and delete, and `offset` (0 to 100,000, not with `cursor`) and `count: true` (adds `total`) on the query. Contract tests for each shape, including `offset` with `cursor` refused.

## M3-02 Mutation ID migration
- **Role:** backend
- **Depends on:** nothing (alongside M3-01)
- **Gate:** needs-human (migration)
- **Acceptance:** `revision.client_mutation_id uuid NULL` with a unique index on `(workspace_id, actor, client_mutation_id)` where it is set (D59), and the API role's insert grant on it. Tests apply it to an empty database and one migrated to `0011`.

## M3-03 Changes reader, HTTP route and idempotent writes
- **Role:** backend
- **Depends on:** M3-01, M3-02
- **Gate:** needs-human (reads under row-level security)
- **Acceptance:** one function reads changes after a sequence for a list of hubs under the caller's identity and collapses each item to its latest state (D58); `GET /changes` serves it to people and agents. Item writes store `clientMutationId`; a retry with a known ID returns the first answer's status with the current item and writes nothing (D59), also when two retries race. Schema writes and access changes `NOTIFY` so the feed can tell clients (D58). Integration tests: a viewer never sees changes in a hub they lack, a revoked grant stops changes, collapse, the retry race.

## M3-04 WebSocket feed
- **Role:** backend
- **Depends on:** M3-03
- **Gate:** needs-human (authentication: session and key on the upgrade, origin check)
- **Acceptance:** `GET /feed` upgrades with `@fastify/websocket` (current release); a session cookie needs a matching `Origin`, a key needs `Authorization`. One dedicated `LISTEN` connection per process, reconnected when Postgres drops it (as #107 did for the pool). Subscriptions per hub with resume from `after`; `resync` past 1,000 missed changes; 50 ms coalescing; `hub` and `access_lost` events; the session or key checked on delivery and every minute, closing the socket when it ends; a cap of 20 subscriptions per socket and 10 sockets per session. Integration tests with two sockets in different roles, a dropped `LISTEN` connection, sign-out closing the socket, and a cross-origin upgrade refused.

## M3-05 Query windows by offset and total count
- **Role:** backend
- **Depends on:** M3-01
- **Acceptance:** the query accepts `offset` and `count` (D61). EXPLAIN tests show the default sort stays an index scan with an offset; a 50,000-item folder answers a window at offset 49,800 in under 100 ms on CI hardware, and `total` in the same time.

## M3-06 Large-folder seed
- **Role:** backend
- **Depends on:** nothing
- **Acceptance:** `pnpm seed:large` creates a hub with one 50,000-item folder (every M1 type, several indexed) in under a minute, with revisions, and is safe to re-run. Used by M3-09 and in CI.

## M3-07 Virtual DataTable
- **Role:** design-system
- **Depends on:** nothing
- **Acceptance:** DataTable gains a virtual mode with `@tanstack/vue-virtual` (current release): fixed 38px rows, a total row count that sizes the scrollbar, placeholder rows for windows not yet loaded, an event asking for the windows in view, keyboard selection that scrolls the row into view, and `aria-rowcount` and `aria-rowindex` so screen readers know the size. Selection and sorting keep working as in M1. Added to the kit page and `docs/DESIGN.md`. Component tests.

## M3-08 Client store and live sync
- **Role:** frontend
- **Depends on:** M3-01, M3-04 (it can start on the store against M3-01's shapes)
- **Acceptance:** the store from D60, one feed connection per tab with reconnect (backoff up to 30 s) and resume, subscriptions for the hubs on screen, and optimistic create, patch and delete with mutation IDs, confirmed by the echo and rolled back on rejection. The folder table, item panel and item page read from it. A `hub` event reloads the schema; `access_lost` shows the no-permission state; `resync` reloads windows. A small connection indicator in the shell when offline. Component tests for apply, rollback, echo, reconnect and resync.

## M3-09 Large folders in the dashboard
- **Role:** frontend
- **Depends on:** M3-05, M3-07, M3-08
- **Acceptance:** the folder view uses the virtual DataTable with 200-row offset windows and `total`, keeps loaded windows in the store, and refetches the visible window on changes that may reorder it (D61). Sorting and filtering reset the windows. Component tests.

## M3-10 Unique hub ID prefixes
- **Role:** backend, then frontend
- **Depends on:** nothing
- **Gate:** needs-human (migration)
- **Acceptance:** a unique index on the hub's prefix per workspace, ignoring case and only on hub rows; the migration stops with a message naming the duplicates if a database already has some. `POST /hubs` answers 409 `prefix_taken`, and the New hub dialog shows it on the prefix field. Tests.

## M3-11 "What each role can do" (#138)
- **Role:** frontend
- **Depends on:** nothing
- **Acceptance:** workspace settings shows a read-only table of workspace and hub roles against actions, generated from `can()` rather than written by hand, so it matches `docs/ROLES.md`. A test fails if an action in `can()` is missing from the table.

## M3-12 Sync end-to-end suite and exit check
- **Role:** qa
- **Depends on:** M3-08, M3-09, M3-06
- **Acceptance:** two browser contexts and one agent key edit the same folder (create, edit the same and different items, delete, a conflicting edit); both browsers show the same rows and values within two seconds of each write, checked against the API. A dropped connection catches up after reconnect. A 50,000-item folder from `seed:large` meets D61's numbers (rows within one second of a jump, no task over 50 ms while scrolling, under 100 rows in the DOM). Runs in the required End-to-end check; if the large folder makes it slower than five minutes, the large-folder test gets its own required job.

## M3-13 M3 report
- **Role:** lead
- **Depends on:** all
- **Acceptance:** `docs/reports/M3.md` in the format of the M2 report.

## Carried over
- **#162** happy-dom and @vue/test-utils for component tests (frontend). Taken if a frontend slot is free; the store's tests do not need it.
- **#134** batching large removals stays in M7.
