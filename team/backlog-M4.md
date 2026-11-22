# Sprint 4 backlog: blocks

The initial plan for M4. Each entry becomes a GitHub issue during planning; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** the "project home" (`design/mockups/Main.dc.html`) and "my work" (`design/mockups/Work.dc.html`) mockups are real root views over real data in a seeded hub. A hub admin composes them in settings, every reader sees them live, and "my work" shows each reader their own items (the M4 exit criterion in `docs/ROADMAP.md`).

**What exists today:** no `view` table (ARCHITECTURE lists it only as the target); no block registry in `packages/core`; summary functions are declared per attribute type but never computed; `can()` has no view action; the web app's folder screen is `ItemsBlock.vue`; a query reads one folder.

**Already decided for M4 (maintainer, 2026-11-22):** the M3 report's answers (#185, #221 to #224, #228, #229, #238, #244 are in M4; #188, #189, #193, #217, #219, #226 stay unscheduled) and the backend track batch in #199 (D64 to D66 as proposed; an upsert that finds the item in another folder patches it where it is).

## Open questions for the maintainer

Every answer below is a **proposal**. Once confirmed they become D76 to D82 in `docs/DECISIONS.md`.

**Q1. How a root view is stored (D76).**
- One root view per folder (the hub root included), or none. No stored view means the folder opens on a default view, `page > table(this folder)`, which looks exactly like today's folder screen.
- Migration `view (workspace_id, id, hub_id, folder_id, tree jsonb, version, updated_at, updated_by)`, unique per folder, composite FK to the folder with `ON DELETE CASCADE` (deleting an empty folder or a hub takes its view), a 128 KiB size check, RLS (Q3).
- Writes replace the whole tree with an expected `version`: 409 `conflict`, 422 `invalid_view` with `errors: [{ path, message }]`. D17's "patch by block ID" is deferred.
- `tree` is `{ schemaVersion: 1, root }`; core's `parseViewTree` upgrades older versions on read, so block config changes need no data migrations.
- No view history in M4. A view write sends the existing `hub` NOTIFY; clients already reload on it.
- **Mockup consequence:** the mockup sidebar entries (Home, My work, Backlog, Sprints, …) are folders. "Home" is the hub root's view; "My work" is an empty folder whose view reads the Tasks folder. Named views per hub would be a new product concept and are not proposed.

**Q2. Block contracts in core (D77).**
- A block is `{ id, type, config, children? }`; ids unique in the tree.
- `BLOCK_TYPES` gives per type: category (layout, content, data), allowed child types (no loops, D14; `page` is root only), a Zod `configSchema`, and binding kind (`none`, `set`, `item`). Web components register against the type names, as attribute types do.
- Caps: 200 blocks, depth 8, 20 data blocks, 128 KiB.
- **M4 block set:** `page`, `section`, `columns`, `heading`, `text` (plain text), `table` (the default view, reuses ItemsBlock), `list` (grouping, group summary, open, create), `board` (group by a select), `number` ("16 of 34"; also "day 6 of 10" from an item's two dates), `chart` (Q6), `fields` (an item's attributes, inline or stacked).
- Deferred: `tabs`, `divider`, `image` (needs file storage, D44), `document`, `comments`, `activity` (M6).

**Q3. Who can edit views (D78; gated change to `docs/ROLES.md` and `can()`).**
- New action `view.edit`, hub admins only; ROLES.md gains "Edit root views". Agent keys are never hub admin (D28), so agents can't edit views. Reading needs `hub.read`.
- RLS on `view` mirrors `attribute`: read with any hub grant, write as hub admin. Hidden hub or folder is 404 (D45).

**Q4. How bindings read data (D79).**
- **Set binding** `{ folderId, where?, sort?, limit }` with `POST /query`'s rules (indexed attributes, 20 conditions, 3 levels, 3 sort keys). The folder must be in the view's own hub (no cross-hub bindings in M4). Lists up to 100 rows; boards up to 20 columns of 25 cards with "+N more".
- **Item binding:** a fixed item, or a rule (`{ folderId, where, sort }`, first match). Binding to another block's selection is deferred.
- **New operands** (core contract): `{ "$me": true }` for actor conditions; `{ "$now": "<ISO 8601 duration>" }` for dates (the same shape as #199, one definition); `{ "$block": "<id>" }` in relation conditions inside views ("items in the current sprint"). `$me` and `$now` are also allowed in `POST /query`.
- A block that refers to a removed or non-indexed attribute or a missing folder stays stored and renders a designed "invalid" state. PUT validates against the current schema; GET never rewrites.
- Every read runs as the caller under RLS, in one read-only snapshot with the workspace `seq` (D58).

**Q5. Aggregates (D80).**
- `POST /v1/workspaces/:w/aggregate` with `{ from: folderId, where?, groupBy?, measures }`.
- One `groupBy` dimension on an indexed select, multi-select, actor, relation or boolean, or a date with a `day`/`week`/`month` bucket and a time zone. Multi-valued attributes count an item in each of its groups, so group counts can sum past the total.
- 1 to 5 measures `{ fn, attribute?, where? }`, `fn` from the type's summaries; a per-measure `where` gives "done of total" in one pass.
- At most 100 groups (the rest fold into `other`, with `truncated`), 366 date buckets. Relation labels only for items the reader can see; the rest count under `no_access`.
- Budget: under 200 ms on a 2,000-item hub (D75), under 2 s on the 50,000-item folder in CI, 3 s statement timeout answering 503 `timeout`. If the budget fails, #193 comes back as a gated item.

**Q6. Mockup parts the data model doesn't have yet (D81).**

| Mockup element | Proposal |
|---|---|
| Burndown | Total points minus the cumulative points done per day, from a "Done on" date attribute, across the bound sprint's dates; ideal line between the same dates. No history time series. |
| Team "Open points" | Grouped by Owner, sum of points not done. The free-text status line is dropped. |
| Release "11 of 12" per epic | Bar rows grouped by Epic, count and count done. The generated sentence becomes a number block. |
| "3 of 5 subtasks" on board cards | Needs a rollup attribute. D44 put rollup in M4, but the exit doesn't need it: **amend D44 and defer rollup**; cards show one configured secondary attribute. |
| "Sara's work" and its sentence | A static "My work" heading and number blocks; no name tokens or generated sentences. |
| "Sprint 24 runs Nov 9 to Nov 20" | A `fields` block bound by rule to the current sprint. |
| "Live" dot | The shell's existing connection state. |

**Q7. View data and live refresh (D82).**
- `GET /v1/workspaces/:w/views/:viewId/data[?blocks=a,b]` answers every data block in one snapshot with one `seq`, with a status per block (`ok`, `invalid`, `not_found`, `error`), at most 1,000 items per response. Item bindings resolve first, then `$block`.
- The client subscribes to the hub from that `seq`; items already shown update in place through the M3 store. Changes in a bound folder refetch only the affected blocks, debounced 300 ms and at most once a second per view. No caching across readers (`$me`).

**Q8. Composer scope.** In hub settings, "Root views", hub admin only: an outline of the tree (add from allowed types, remove, move up and down), a form per block type generated from the registry (folder, attribute, sort and limit pickers), filters as a one-level condition list plus "Edit as JSON" for nested trees, a live preview, Save with version (409 with Reload), Reset to default. No drag and drop.

**Q9. #229.** Make the sign-in rate limit configurable through the environment, raised only for the e2e servers; production defaults unchanged.

## Issues

### Gate batch (maintainer review)

#199 (in progress) and #185 (in progress) are already open as their own gated PRs. M4-01 and M4-02 are the blocks batch, opened as one PR with one commit per issue, reviewed in the same sitting as whichever of #199 and #185 is still open. The core parts of #221 (refuse NUL with 400) and #222 (an unreadable history patch comes back as `{ patch: null, unreadable: true }`) ride in the same batch.

## M4-01 View, block, aggregate and view-data contracts in core
- **Role:** backend · **Depends on:** this plan (D76 to D82) · **Gate:** needs-human (`packages/core`, ROLES.md)
- **Acceptance:** core exports the view tree and `parseViewTree`; `BLOCK_TYPES` with config schemas, allowed children and caps; set and item bindings; `$me`, `$now` (shared with #199) and `$block`; view GET/PUT/DELETE shapes and errors; aggregate and view-data request and response shapes with their limits; `view.edit` in `can()` and the ROLES.md row. Contract tests for every block type valid and invalid, a non-root page, a disallowed child, duplicate ids, over-depth and over-size trees, `$block` outside views, non-indexed group or measure, a summary not allowed for the type, and the role table.

## M4-02 Migration: the view table
- **Role:** backend · **Depends on:** nothing (alongside M4-01; numbered after #199's) · **Gate:** needs-human (migration, RLS)
- **Acceptance:** `view` as in Q1 with RLS and grants; `delete_hub` still succeeds on a hub with views. Tests: up, down and up again; an editor's write refused by RLS; an agent refused; deleting a folder removes its view.

### Backend

## M4-03 Root view API
- **Role:** backend · **Depends on:** M4-01, M4-02
- **Acceptance:** `GET /folders/:folderId/view` (stored view, or the default with `stored: false, version: 0`), `PUT { tree, version }`, `DELETE` (reset). PUT checks the tree against the hub's schema (same-hub folders, attached attributes, indexed where filtered, sorted, grouped or summed). 404 hidden folder, 403 without `view.edit`, 409 stale version, hub NOTIFY on write. Integration tests per role and for the version race.

## M4-04 Aggregate engine, `POST /aggregate`, `$me` and `$now` in queries
- **Role:** backend · **Depends on:** M4-01
- **Acceptance:** Q5 as the caller under RLS in one snapshot; `$me` and `$now` resolved for `/query` and `/aggregate` with the database clock. Tests per summary function and type, date buckets with a time zone, multi-valued groups, over 100 groups, no counting of rows the reader can't see, the timeout, and the two timing budgets.

## M4-05 View data endpoint
- **Role:** backend · **Depends on:** M4-03, M4-04
- **Acceptance:** Q7 with per-block statuses, one snapshot and `seq`, caps. Tests: the seeded views return the expected numbers; two readers get different "my work"; removing an attribute makes only its blocks `invalid`; a `?blocks=` subset.

## M4-06 Project hub seed
- **Role:** backend · **Depends on:** M4-01, M4-02
- **Acceptance:** `pnpm seed` adds a "Parcel Tracker" hub to `demo` with Sprints, Tasks, Epics and an empty "My work" folder; Tasks has Stage, Owner, Reviewer, Points, Sprint, Epic, Done on, Bucket and Rank, indexed where the views need it; the mockups' sample data with dates relative to the seed day; both root views stored; an editor, a viewer and an agent key. Safe to re-run, and never overwrites a view a hub admin edited.

### Design system

## M4-07 Block presentation components
- **Role:** design-system · **Depends on:** nothing
- **Acceptance:** from the two mockups, in both themes: PageHeader (with the live dot), Section, Columns, NumberStat, GroupedList, BoardColumn and BoardCard, BarRows, FieldsInline. Each with D18's states plus "invalid". On the kit page and in DESIGN.md. Screens without a mockup (empty and invalid states) flagged for the maintainer.

## M4-08 Chart component
- **Role:** design-system · **Depends on:** nothing
- **Acceptance:** a chart library at its current release, lazy-loaded out of the main bundle; burndown (actual, dashed ideal, "Today") and horizontal bars; colours from tokens, follows the theme; a hidden data table for screen readers; no task over 50 ms while rendering on a production build.

### Frontend

## M4-09 View renderer, layout and content blocks
- **Role:** frontend · **Depends on:** M4-01 (branch shapes), M4-07; M4-05 for real data
- **Acceptance:** the web block registry; HubPage renders the folder's root view or the default (identical to today); loads view and data, subscribes from `seq`, refreshes per block (Q7), reloads on a `hub` event; `page`, `section`, `columns`, `heading`, `text`; one broken block never breaks the page.

## M4-10 Data blocks
- **Role:** frontend · **Depends on:** M4-09, M4-08
- **Acceptance:** `table`, `list`, `board`, `number`, `chart`, `fields`; opening an item uses the existing panel or page; updates in place from the store.

## M4-11 Root view composer
- **Role:** frontend · **Depends on:** M4-03, M4-09 (M4-10 for the preview)
- **Acceptance:** Q8, hub admins only; 422 errors shown at their paths; a test fails if a block type has no form.

### QA and lead

## M4-12 Blocks end-to-end suite and exit check
- **Role:** qa · **Depends on:** M4-05, M4-06, M4-10, M4-11, #228
- **Acceptance:**
  1. After `pnpm seed`, project home and my work: every number, chart series, board count, group summary and field is checked against `/aggregate` and `/query` for the same binding.
  2. Two people see different "my work"; a viewer sees the views without "New item".
  3. An agent key patches a task over HTTP; within 2 s both browsers show the card's new column, the updated numbers, burndown and team row. Creates and deletes appear and disappear.
  4. A hub admin builds "my work" in the composer from the default view, saves, and it renders; a stale tab gets the 409; editor and viewer see no composer.
  5. Removing an attribute a block uses breaks only that block.
  6. On a production build: project home within 1 s seeded and 2 s at 2,000 tasks; no task over 50 ms while the chart renders.
  7. Screenshots of both views in both themes on the PR, with the Q6 differences listed.

## M4-13 M4 report
- **Role:** lead · **Depends on:** all · **Acceptance:** `docs/reports/M4.md` in the M3 format, including the backend track.

### Backend track and carry-overs (already filed)

| Issue | Role | Depends on | When |
|---|---|---|---|
| #199 contracts and migration | backend | – | in progress (gated) |
| #185 long sort cursors | backend | – | in progress (gated) |
| #238 item panel scroll | design-system | – | in progress |
| #244 feed test flake, #229 sign-in limit | backend | Q9 for #229 | wave 1, while the gate batch waits |
| #223 rich text draft | frontend | – | wave 1 |
| #200 external keys, #203 preconditions | backend | #199 | wave 2 |
| #221, #222 API parts, #224 | backend | the gate batch | wave 2 |
| #228 e2e production build only when needed | infra | – | wave 2, before M4-12 |
| #202 batch writes | backend | #200, #203 | wave 3 |
| #204 key on the item page | frontend | #200 | wave 3 |

## Sequence (3 agents at a time)

- **Wave 0:** this plan reviewed; the maintainer answers Q1 to Q9 and the D44 rollup point; D76 to D82 recorded.
- **Wave 1:** backend opens the blocks gate batch (M4-01, M4-02), then #244 and #229 while it waits; design-system #238, then M4-07, then M4-08; frontend #223, then M4-09 against the batch branch's shapes.
- **Wave 2 (batch merged):** backend M4-03, M4-04, M4-05; a second backend slot (when design-system frees one) on #200, #203, #221/#222 API parts, #224; frontend finishes M4-09 on real data, then M4-10.
- **Wave 3:** backend M4-06 and #202; frontend M4-11 and #204.
- **Wave 4:** QA M4-12 (after #228); the lead writes M4-13.

Critical path: the gate batch review, then M4-03, M4-04, M4-05, M4-10, M4-12.

## Deferred (not needed for the exit)

`tabs`, `divider`, `image`, `document`, `comments`, `activity` blocks; selection bindings; board drag and drop; the rollup attribute type (D44 amended); patch by block ID, view history, named or multiple views per folder; cross-hub bindings; two-dimension grouping and other chart kinds; burndown from history; generated sentences in text blocks.
