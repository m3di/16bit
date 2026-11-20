# Sprint 3 backlog: sync

The initial plan for M3. Each entry becomes a GitHub issue during planning; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** two browsers and one agent editing the same folder stay consistent without reloading, and a 50,000-item folder scrolls smoothly (the M3 exit criterion in `docs/ROADMAP.md`).

**Decisions this plan rests on:** D57 (feed transport: one WebSocket per tab plus an HTTP changes route, subscriptions per hub), D58 (events read under the subscriber's identity, item as it is now, resume and resync), D59 (client mutation IDs), D60 (the client store), D61 (virtual scrolling, offset windows, the stable `number` order, and what "smooth" means; amends D20). After the review of the planning PR (#167) the plan gained a `seq` on read responses and a high-water `seq` on every `changes` message, HTTP confirmation of writes, the WebSocket security rules in D57, immediate socket closing on sign-out and revocation, the `number` order, and a bound for attribute sorts. From the M2 report: D56 (unique hub ID prefixes), D18 reworded to five states, and #138.

## Answers to the M2 report

The maintainer asked the lead to decide all five questions:

1. **ID prefixes** are unique per workspace (D56, M3-10).
2. **The New hub dialog** stays as built.
3. **Table headers** stay 32px, on the 4px grid; `docs/DESIGN.md` already says so and the mockups' 30px is superseded.
4. **"What each role can do"** is built, generated from `can()` so it cannot drift from `docs/ROLES.md` (#138, M3-11).
5. **D18** now names a fifth state, not found, for anything opened by ID.

---

## M3-01 Sync contracts in core
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (`packages/core` contracts)
- **Acceptance:** `packages/core` exports: the feed protocol (client messages `subscribe`, `unsubscribe` with a hub ID and `after`; server messages `changes` with a high-water `seq` and `{ seq, hubId, itemId, item | null, clientMutationId? }[]`, `hub` with the hub's version, `access_lost`, `resync`, `error` with `not_found` among its codes), the `GET /changes` request and response (paged by `after` and `limit`, up to 1,000, with the high-water `seq`), an optional `clientMutationId` on item create, patch and delete, a `seq` on item, query and hub responses (D58), and on the query `offset` (0 to 100,000, not with `cursor`), `count: true` (adds `total`) and `order: "updated" | "number"` (default `updated`; refused together with `sort`; the cursor records its order and is refused under the other, and under `number` it pages by item number) (D61). Client messages have a 4 KiB cap. Contract tests for each shape, including `offset` with `cursor` refused, `order` with `sort` refused, a cursor from the other order refused, and an oversized message.

## M3-02 Migration: mutation IDs and the number index
- **Role:** backend
- **Depends on:** nothing (alongside M3-01)
- **Gate:** needs-human (migration)
- **Acceptance:** migration `0012`: `revision.client_mutation_id uuid NULL` with a unique index on `(workspace_id, actor, client_mutation_id)` where it is set (D59), the API role's insert grant on it, and the index `(workspace_id, folder_id, seq_id DESC)` on `item` for the `number` order (D61). Tests apply it to an empty database and one migrated to `0011`.

## M3-03 Changes reader, HTTP route and idempotent writes
- **Role:** backend
- **Depends on:** M3-01, M3-02
- **Gate:** needs-human (reads under row-level security)
- **Acceptance:** one function reads changes after a sequence for a list of hubs under the caller's identity and collapses each item to its latest state (D58); `GET /changes` serves it to people and agents. Every `GET /changes` page and feed batch carries a high-water `seq`: the workspace counter when the page is complete, the last returned row's `seq` when `limit` or a cap cut it short. Item, query and hub responses read the workspace `seq` and their rows in one `REPEATABLE READ READ ONLY` transaction, so the `seq` is never newer than the rows (requests otherwise run at READ COMMITTED) (D58). Item writes store `clientMutationId`; a retry with a known ID returns the first answer's status with the current item and writes nothing, also when two retries race, and the same ID with a different item or operation is a 422 (D59). Schema writes, access changes, sign-out, member removal, key revocation and password resets `NOTIFY` so the feed can act on them (D58). Integration tests: a viewer never sees changes in a hub they lack, the high-water `seq` moves past hidden changes, a revoked grant stops changes, collapse, the retry race, a reused ID refused, an item changed between a query and `GET /changes` after its `seq` is not missed (with a write forced between the two reads), and a page cut short by `limit` is followed by the rows it left out.

## M3-04 WebSocket feed
- **Role:** backend
- **Depends on:** M3-03
- **Gate:** needs-human (authentication: session and key on the upgrade, origin check)
- **Acceptance:** `GET /feed` upgrades with `@fastify/websocket` (current release), following D57: authentication, D49 and the workspace checked before the upgrade as plain HTTP errors, a cookie upgrade only with an `Origin` whose host equals `Host`, client messages parsed with the core schemas and capped at 4 KiB, and the same `not_found` for a missing, hidden or out-of-scope hub. One dedicated `LISTEN` connection per process, reconnected when Postgres drops it (as #107 did for the pool). Subscriptions per hub with resume from `after`; `resync` past 1,000 missed changes the subscriber could see; 50 ms coalescing; `hub` and `access_lost` events; sockets closed at once on sign-out, member removal, key revocation and password reset, and the session or key checked every minute; a cap of 20 subscriptions per socket and 10 sockets per session. `ws: true` on the `/v1` proxy in `apps/web/vite.config.ts` so the feed works under `pnpm dev`. Integration tests with two sockets in different roles, a dropped `LISTEN` connection, sign-out and key revocation closing the socket within a second, a cross-origin upgrade refused, cookie and `Authorization` together refused, and a hidden hub answering like a missing one.

## M3-05 Query windows by offset, total count and the number order
- **Role:** backend
- **Depends on:** M3-01, M3-02, M3-06
- **Acceptance:** the query accepts `offset`, `count` and `order: "number"` (D61). `total` comes from `folder.item_count` when there is no `where`. EXPLAIN tests show both orders stay index scans with an offset. On a 50,000-item folder a window at offset 49,800 answers in under 500 ms on CI hardware, and one with an attribute sort, a filter and `count: true` in under two seconds.

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
- **Acceptance:** the store from D60, one feed connection per tab with reconnect (backoff up to 30 s) and resume, subscriptions for the hubs on screen, and optimistic create, patch and delete with mutation IDs, confirmed by the HTTP response, rolled back on rejection, and not applied twice when the echo arrives (D59). Every live read subscribes with the `seq` it came with; an item is applied only if its version is newer, and deleted IDs keep a tombstone (D58). The folder table, item panel and item page read from it. A `hub` event reloads the schema; `access_lost` shows the no-permission state; `resync` reloads windows. A small connection indicator in the shell when offline. Component tests for apply, rollback, echo, reconnect and resync, and that a stale version or late event never overwrites a newer item, a tombstone stops a deleted row coming back, a subscription uses the read's `seq`, and a write made while the socket is down is confirmed.

## M3-09 Large folders in the dashboard
- **Role:** frontend
- **Depends on:** M3-05, M3-07, M3-08
- **Acceptance:** the folder view uses the virtual DataTable with 200-row offset windows, `total` and the `number` order by default, keeps loaded windows in the store, updates rows in place, and with an attribute sort or a filter refetches the visible window on changes that may reorder it, keeping the selected row in view (D61). Sorting and filtering reset the windows. Component tests.

## M3-10 Unique hub ID prefixes
- **Role:** backend, then frontend
- **Depends on:** M3-02 (its migration is `0013`)
- **Gate:** needs-human (migration)
- **Acceptance:** a unique index on the hub's prefix per workspace, only on hub rows; the migration stops with a message naming the duplicates if a database already has some. `POST /hubs` answers 409 `prefix_taken`, and the New hub dialog shows it on the prefix field. Tests.

## M3-11 "What each role can do" (#138)
- **Role:** frontend
- **Depends on:** nothing
- **Acceptance:** workspace settings shows a read-only table of workspace and hub roles against actions, generated from `can()` rather than written by hand, so it matches `docs/ROLES.md`. A test fails if an action in `can()` is missing from the table.

## M3-12 Sync end-to-end suite and exit check
- **Role:** qa
- **Depends on:** M3-08, M3-09, M3-06
- **Acceptance:** two browser contexts and one agent key edit the same folder (create, edit the same and different items, delete, a conflicting edit); both browsers show the same rows and values within two seconds of each write, checked against the API. A dropped connection catches up after reconnect, and an HTTP write made while the socket is down is confirmed. A 50,000-item folder from `seed:large` meets D61's numbers for the default order (rows within one second of a jump, as the median of several jumps, no `longtask` over 50 ms while scrolling, under 100 rows in the DOM). Runs in the required End-to-end check. If the large folder makes it slower than five minutes, QA proposes a separate required job; changing the required checks is gated.

## M3-13 M3 report
- **Role:** lead
- **Depends on:** all
- **Acceptance:** `docs/reports/M3.md` in the format of the M2 report.

## Carried over
- **#162** happy-dom and @vue/test-utils for component tests (frontend). Taken if a frontend slot is free; the store's tests do not need it.
- **#134** batching large removals stays in M7.
