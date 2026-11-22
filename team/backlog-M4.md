# Sprint 4 backlog: blocks

The initial plan for M4. Each entry becomes a GitHub issue during planning; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** the "project home" (`design/mockups/Main.dc.html`) and "my work" (`design/mockups/Work.dc.html`) mockups are real root views over real data in a seeded hub. A hub admin composes them in settings, every reader sees them live, and "my work" shows each reader their own items (the M4 exit criterion in `docs/ROADMAP.md`).

**What exists today:** no `view` table (ARCHITECTURE lists it only as the target); no block registry in `packages/core`; summary functions are declared per attribute type but never computed; `can()` has no view action; the web app's folder screen is `ItemsBlock.vue`; a query reads one folder.

**Already decided for M4 (maintainer, 2026-11-22):** the M3 report's answers (#185, #221 to #224, #228, #229, #238, #244 are in M4; #188, #189, #193, #217, #219, #226 stay unscheduled) and the backend track batch in #199 (D64 to D66 as proposed; an upsert that finds the item in another folder patches it where it is).

**Changes after review (#247):** the questions are renumbered Q1 to Q11 and each new choice is marked **Decide**. New: views-only folders, "Opens on" and folder delete with a view (Q1); the D15, D17 and D44 amendments in one place (Q2); board columns, row fields, two group measures, create target and `$block` rules (Q3); `view.edit` dropped for `hub.manageSchema` (Q4); actor IDs only and one `no_access` group (Q6); time zone and working days (Q7); Backlog instead of Tasks, Type, the release line and Team in Q8; a request deadline, a per-principal limit, a total condition cap, a folder-keyed data route with the tree version and fuller refresh rules (Q9); #228's gate (Q11). Issues: M4-00 aggregate spike in wave 1; M4-02 spells out FK, RLS and grants; M4-03 versioned reset, unique-violation 409, schema lock and ARCHITECTURE.md; M4-06 moves to wave 2 with a 2,000-task fixture and a generated agent key; #199 owns `$now`; #229 is labelled `needs-human`; M4-08 names the chart library. From the optional points: 24, 26, 27, 28 and 29 are taken; 25 (Team as items) is not, see Q8.

**Changes after the second review:** `opens_on_folder_id` is a column on the hub's folder row, guarded by `folder_guard` and the folder UPDATE grant and built like `title_attribute_id` (M4-02); the `view` grants include `SELECT`; the per-principal limit is 4 in flight per API process, and the client queues and retries a 429 silently (Q9). Optional points taken: a trigger keeps views-only folders empty; a designed "No view yet" state; "New item" presets only top-level `AND` equality conditions; M4-08 is a hand-written SVG burndown, so no chart dependency is added.

## Decisions (were open questions)

**Decided by the maintainer on 2026-11-22, all as proposed** (PR #247), and recorded as D76 to D83 in `docs/DECISIONS.md`. The **Decided** lines were the choices the plan could not make alone; the alternatives were not taken.

**Q1. How a root view is stored, and views-only folders (D76).** **Decided** as proposed.

- One root view per folder (the hub root included), or none. No stored view means the folder opens on a default view, `page > table(this folder)`, which looks exactly like today's folder screen. A views-only folder has no items, so its default is a designed "No view yet" state, with "Compose" for hub admins.
- Migration `view (workspace_id, id, hub_id, folder_id, tree jsonb, version, updated_at, updated_by)`, unique per folder, composite FK `(workspace_id, hub_id, folder_id) REFERENCES folder (workspace_id, hub_id, id) ON DELETE CASCADE` (so `delete_hub` takes the views), a 128 KiB size check, RLS (Q4).
- Writes replace the whole tree with an expected `version`: 409 `conflict`, 422 `invalid_view` with `errors: [{ path, message }]`. Reset is `DELETE ?version=` with the same 409. Two first-time PUTs at `version: 0` that hit the unique constraint answer 409 `conflict`, never 500.
- `tree` is `{ schemaVersion: 1, root }`; core's `parseViewTree` upgrades older versions on read, so block config changes need no data migrations.
- No view history in M4. A view write sends the existing `hub` NOTIFY; clients already reload on it.
- **Decided: views-only folders and "Opens on".** Adopt `HubSettings.dc.html`. `folder.views_only` (set at creation, never updated) marks a folder that holds no items: item create and move into it answer 422 `views_only` (a trigger on `item` holds this underneath, as `hub_id_check` does for D3), the sidebar (#231) shows "Views only" instead of a count, and the folder menu (#233) offers no "New item". `opens_on_folder_id` on the hub's folder row (null is the hub root; a hub admin's setting, like the title attribute) picks the folder a hub opens on. Home and My work are views-only folders; the hub opens on Home. Both columns ride in M4-02.
- **Decided: deleting a folder that has a stored view.** Refused with 409 `has_view`; the admin resets the view first, so a composed view is never lost in one click (D52). Either way `delete_hub` cascades.

**Q2. Amending recorded decisions.** **Decided:** all three approved; recorded in D76, D77 and the amended rows:

- D15: 6 of the 17 block types (`tabs`, `divider`, `image`, `document`, `comments`, `activity`) wait for later milestones; `image` needs file storage (D44).
- D17: "patch by block ID" is deferred; writes replace the whole tree with a version (Q1).
- D44: rollup is deferred; the exit doesn't need it (Q8, "3 of 5 subtasks").

**Q3. Block contracts in core (D77).** **Decided** as proposed.

- A block is `{ id, type, config, children? }`; ids unique in the tree.
- `BLOCK_TYPES` gives per type: category (layout, content, data), allowed child types (no loops, D14; `page` is root only), a Zod `configSchema`, and binding kind (`none`, `set`, `item`). Web components register against the type names, as attribute types do.
- Caps: 200 blocks, depth 8, 20 data blocks, 128 KiB.
- **M4 block set:** `page`, `section`, `columns`, `heading`, `text` (plain text), `table` (the default view, reuses ItemsBlock), `list`, `board`, `number` ("16 of 34"; also "day 6 of 10" from an item's two dates, counted as Q7 says), `chart` (Q8), `fields` (an item's attributes, inline or stacked).
- **`list` and `board` rows and cards:** a `fields` list of up to 4 attribute IDs after the title (backlog: ID, Type, Epic, Points; current work: Stage, Owner; cards: ID, Points), each with an optional `emptyText` ("No epic", "?"); a select shows its option colour as a dot.
- **`list` groups:** group by one attribute, with up to 2 group measures ("Next up 19 points", "Later 1 not estimated" is `sum` plus `count_empty`).
- **`board` columns:** an ordered subset of the select's options (up to 20; the Work board hides Done), empty columns always shown with an `emptyText` per column or a board default ("Nothing of yours is in review.").
- **Create** (`list`, `board`): creates in the set binding's `folderId`, shown only with `item.write` there; it presets the group's or column's value and the binding's top-level `AND` equality conditions (`attribute = value` or `= $me`), so the new item appears in the block. An `OR` presets nothing: on the Work board ("Owner or Reviewer is me") create sets only Stage. A views-only folder's "New item" therefore creates in Backlog.
- **`$block` rules:** it may name only an item-bound block, and item-binding rules may not use `$block` (no chains or cycles). When the named block resolves to nothing (no current sprint, or the sprint is hidden), dependent blocks get the status `unresolved` and render a designed empty state, not an error.

**Q4. Who can edit views (D78; gated change to `docs/ROLES.md`).** **Decided** as proposed.

- Editing a root view needs `hub.manageSchema` (hub admin), so `can()` gains no action; ROLES.md gains the row "Edit root views", hub admin only. Agent keys are never hub admin (D28), so agents can't edit views. Reading needs `hub.read`.
- RLS on `view` mirrors `attribute`: read with any hub grant, write as hub admin, insert and update `WITH CHECK` including `updated_by = rls_principal()`. Hidden hub or folder is 404 (D45).

**Q5. How bindings read data (D79).** **Decided** as proposed.

- **Set binding** `{ folderId, where?, sort?, limit }` with `POST /query`'s rules (indexed attributes, 20 conditions, 3 levels, 3 sort keys). The folder must be in the view's own hub (no cross-hub bindings in M4). Lists up to 100 rows; boards up to 20 columns of 25 cards with "+N more".
- **Item binding:** a fixed item, or a rule (`{ folderId, where, sort }`, first match). Binding to another block's selection is deferred.
- **New operands** (core contract): `{ "$me": true }` for actor conditions; `{ "$now": "<ISO 8601 duration>" }` for dates, defined once by #199 (M4-01 imports it; the blocks batch is based on #199's branch if #199 hasn't merged); `{ "$block": "<id>" }` in relation conditions inside views ("items in the current sprint", rules in Q3). `$me` and `$now` are also allowed in `POST /query`.
- A block that refers to a removed or non-indexed attribute or a missing folder stays stored and renders a designed "invalid" state. PUT validates against the current schema, holding the hub's schema lock (D55) shared; GET never rewrites.
- Every read runs as the caller under RLS, in one read-only snapshot with the workspace `seq` (D58).

**Q6. Aggregates (D80).** **Decided** as proposed.

- `POST /v1/workspaces/:w/aggregate` with `{ from: folderId, where?, groupBy?, measures }`.
- One `groupBy` dimension on an indexed select, multi-select, actor, relation or boolean, or a date with a `day`/`week`/`month` bucket in the request's time zone (Q7). Multi-valued attributes count an item in each of its groups, so group counts can sum past the total.
- 1 to 5 measures `{ fn, attribute?, where? }`, `fn` from the type's summaries; a per-measure `where` gives "done of total" in one pass. At most 40 conditions across `where` and every measure's `where` together.
- At most 100 groups (the rest fold into `other`, with `truncated`), 366 date buckets.
- **What a group reveals:** actor groups return principal IDs only; the client resolves names and kinds from the member list the caller can already read, so an agent sees no other principal's name or kind (ROLES.md). Relation groups return a target's ID and label only when the reader can see it; every hidden target folds into one `no_access` group, so neither their IDs nor their number is revealed (this matters for cross-hub targets, D11).
- Budget: under 200 ms on a 2,000-item hub (D75), under 2 s on the 50,000-item folder in CI, 3 s statement timeout answering 503 `timeout`. The M4-00 spike measures this before the gate batch opens, so any index or policy change rides in M4-02.

**Q7. Time: zone and working days (D81).** **Decided** as proposed.

- **Decided: where the time zone comes from.** The reader's browser zone, sent as `tz` on every view-data and aggregate request; UTC when absent (agents). It sets "today", the current sprint (`start <= $now <= end` on date-only values), date buckets and day counts. A zone not in `pg_timezone_names` answers 422 `invalid_time_zone`, never a 500 from `AT TIME ZONE`.
- **Decided: weekdays or calendar days.** Weekdays (Monday to Friday, no holiday calendar), as the mockup's numbers need: Nov 9 to Nov 20, 2026 is 10 weekdays and Nov 16 is day 6, where calendar days would read "8 of 12". `number` and `chart` configs get `days: "weekdays" | "calendar"`, default `"weekdays"`; the burndown x-axis steps over the same days.

**Q8. Mockup parts the data model doesn't have yet (D82).** **Decided** as proposed.

| Mockup element | Proposal |
| --- | --- |
| Burndown | Total points minus the cumulative points done per day (Q7), from a "Done on" date attribute, across the bound sprint's dates; ideal line between the same dates. No history time series. |
| "Open bugs 7" and the Bug/Story/Chore column | A Type select on Backlog (Bug, Story, Chore). |
| Team "Open points" | Grouped by Owner, sum of points not done. The free-text status line is dropped. The Team folder is not seeded; modelling members as items would only bring back the status line. |
| Release "11 of 12" per epic | Bar rows grouped by Epic, count and count done, over all epics: filtering by the epic's release goes through a relation's attribute, which D20 does not allow. The generated sentence becomes a number block. |
| "Release 2.0 is planned for Dec 11" | Dropped; no release item or date is seeded. |
| "3 of 5 subtasks" on board cards | Needs rollup (deferred, Q2); cards show ID and points. |
| "Sara's work" and its sentence | A static "My work" heading and number blocks; no name tokens or generated sentences. |
| "Sprint 24 runs Nov 9 to Nov 20" | A `fields` block bound by rule to the current sprint. |
| "Live" dot | The shell's existing connection state. |

**Q9. View data and live refresh (D83).** **Decided** as proposed.

- `GET /v1/workspaces/:w/folders/:folderId/view/data?version=N[&blocks=a,b][&tz=]` answers the folder's view, stored or default (version 0), so the route needs no view ID. If the stored tree has moved past `version`, it answers 409 `stale` and the client reloads the view.
- Every data block in one snapshot with one `seq`, with a status per block (`ok`, `invalid`, `not_found`, `unresolved`, `error`), at most 1,000 items per response. Item bindings resolve first, then `$block`.
- **Budget:** one 5 s deadline for the whole request; blocks that haven't run by then get `error: timeout`. Up to 4 view-data or aggregate requests in flight per principal per API process; a fifth answers 429. It is a guard, not a global quota (D34 scales API pods). The client queues a 429 and retries it after its own in-flight requests finish, with no error state, so two tabs, the composer's preview and overlapping refetches all render.
- The client subscribes to the hub from that `seq`; items already shown update in place through the M3 store. A block refetches when anything changes in its bound folder, in the folder of an item binding it uses through `$block` (editing the sprint's dates refetches the burndown and every "this sprint" block), or in a relation's target folder it shows labels from (an epic rename). Refetches are debounced 300 ms and at most once a second per view. Blocks using `$now` also refetch at midnight in the request's zone. No caching across readers (`$me`).

**Q10. Composer scope.** **Decided** as proposed. In hub settings, "Root views", hub admin only: an outline of the tree (add from allowed types, remove, move up and down), a form per block type generated from the registry (folder, attribute, sort and limit pickers), filters as a one-level condition list plus "Edit as JSON" for nested trees, a live preview, Save with version (409 with Reload), Reset to default. No drag and drop. The composer has no mockup (M4-07 flags it). Hub settings also gain "Opens on" and the views-only option on New folder (Q1).

**Q11. Gating of #228 and #229.** **Decided** as proposed.

- #229 changes the sign-in rate limit, which is authentication, so it is labelled `needs-human`. **Decided:** make the limit configurable through the environment, raised only for the e2e servers; production defaults unchanged.
- **Decided: #228 is not gated.** It changes which web build the CI e2e job uses, but no secrets, deployment or workflow permissions.

## Issues

### Gate batch (maintainer review)

#199 (in progress) and #185 (in progress) are already open as their own gated PRs. M4-01 and M4-02 are the blocks batch, opened as one PR with one commit per issue, reviewed in the same sitting as whichever of #199 and #185 is still open. #199 owns `$now`; M4-01 imports it. The core parts of #221 (refuse NUL with 400) and #222 (an unreadable history patch comes back as `{ patch: null, unreadable: true }`) ride in the same batch.

## M4-00 Aggregate cost spike

- **Role:** backend · **Depends on:** nothing · **Gate:** none (findings only)
- **Acceptance:** the Q6 aggregate SQL (a group plus 5 measures, under RLS as an editor) on `seed:large`'s 50,000-item folder: EXPLAIN and timings posted on the issue. Any index or policy change it needs is added to M4-02; if the 2 s budget can't be met, that is raised with the gate batch, not after it.

## M4-01 View, block, aggregate and view-data contracts in core

- **Role:** backend · **Depends on:** this plan (D76 to D83), #199 for `$now` · **Gate:** needs-human (`packages/core`, ROLES.md)
- **Acceptance:** core exports the view tree and `parseViewTree`; `BLOCK_TYPES` with config schemas (row and card fields, board columns, group measures, `days`), allowed children and caps; set and item bindings; `$me` and `$block` (with #199's `$now`); view GET/PUT/DELETE shapes and errors; aggregate and view-data request and response shapes with their limits, `tz` and statuses; the ROLES.md row. Contract tests for every block type valid and invalid, a non-root page, a disallowed child, duplicate ids, over-depth and over-size trees, `$block` outside views, `$block` naming a set-bound block, `$block` inside an item-binding rule, over 40 total conditions, non-indexed group or measure, a summary not allowed for the type, and the role table.

## M4-02 Migration: the view table, views-only folders, "Opens on"

- **Role:** backend · **Depends on:** nothing (alongside M4-01; numbered after #199's), M4-00 for any index · **Gate:** needs-human (migration, RLS)
- **Acceptance:** `view` as in Q1, its FK `(workspace_id, hub_id, folder_id) REFERENCES folder (workspace_id, hub_id, id)`; RLS read with any hub grant, insert and update as hub admin with `WITH CHECK` including `updated_by = rls_principal()`; grants `SELECT, INSERT, DELETE` plus `UPDATE (tree, version, updated_at, updated_by)`, never `workspace_id`, `hub_id` or `folder_id` (`view` is a new table, so it needs its own `SELECT`). `folder.views_only`, not in the folder UPDATE grant, with a `BEFORE INSERT OR UPDATE OF folder_id` trigger on `item` refusing a views-only folder. `folder.opens_on_folder_id` copies `title_attribute_id` exactly: `CHECK (opens_on_folder_id IS NULL OR parent_id IS NULL)` (hub rows only), the same-hub FK `(workspace_id, hub_id, opens_on_folder_id) REFERENCES folder (workspace_id, hub_id, id) ON DELETE SET NULL (opens_on_folder_id)`, a partial index `WHERE opens_on_folder_id IS NOT NULL` for the SET NULL lookup, added to the folder UPDATE column grant and to `folder_guard`'s column list (replaced by the new migration, 0009 stays as merged), so editors, whom `folder_update` admits for the counters, can't write it. Tests: up, down and up again; an editor's write refused by RLS; an agent refused; a `hub_id` that doesn't match the folder refused by the FK; an editor's UPDATE of `opens_on_folder_id` refused with 42501; a folder from another hub refused by the FK; the column refused on a non-hub row; an item insert or move into a views-only folder refused by the trigger; `delete_hub` (`SECURITY DEFINER`) succeeds on a hub with views and removes them; deleting the opens-on folder clears `opens_on_folder_id`.

### Backend

## M4-03 Root view API

- **Role:** backend · **Depends on:** M4-01, M4-02
- **Acceptance:** `GET /folders/:folderId/view` (stored view, or the default with `stored: false, version: 0`), `PUT { tree, version }`, `DELETE ?version=` (reset). PUT takes the hub's schema lock shared and checks the tree against the hub's schema (same-hub folders, attached attributes, indexed where filtered, sorted, grouped or summed). 404 hidden folder, 403 without `hub.manageSchema`, 409 stale version on PUT and DELETE, 409 `conflict` on the unique violation, hub NOTIFY on write. Folder delete with a stored view as Q1 decides; folder create takes `views_only`; item create and move into a views-only folder answer 422 `views_only`; hub update sets `opens_on_folder_id`. Exports the tree validation for the seed. Updates `docs/ARCHITECTURE.md`: the `/v1/workspaces/:w` prefix on the view and aggregate routes (D40), the folder-keyed data route, and `view.updated_at`, `updated_by`. Integration tests per role, the version race on PUT and DELETE, and two concurrent first PUTs; folder delete with a view; a views-only folder refusing an item.

## M4-04 Aggregate engine, `POST /aggregate`, `$me` and `$now` in queries

- **Role:** backend · **Depends on:** M4-01, M4-00
- **Acceptance:** Q6 as the caller under RLS in one snapshot; `$me` and `$now` resolved for `/query` and `/aggregate` with the database clock and the request's `tz` (422 on an unknown zone). Tests per summary function and type, date buckets with a time zone, multi-valued groups, over 100 groups, no counting of rows the reader can't see, an agent's group by Owner returning IDs only, hidden relation targets in one `no_access` group with no IDs or labels, the condition cap, the timeout, and the two timing budgets.

## M4-05 View data endpoint

- **Role:** backend · **Depends on:** M4-03, M4-04, M4-06
- **Acceptance:** Q9 with per-block statuses, one snapshot and `seq`, caps, the 5 s deadline and the per-process limit of 4. Tests: the seeded views return the expected numbers; two readers get different "my work"; removing an attribute makes only its blocks `invalid`; no current sprint makes its dependents `unresolved`; a `?blocks=` subset; a stale `version` answers 409; the default view of a folder with none stored; a fifth concurrent request from one principal answers 429.

## M4-06 Project hub seed

- **Role:** backend · **Depends on:** M4-01, M4-02, M4-03 (tree validation)
- **Acceptance:** `pnpm seed` adds a "Parcel Tracker" hub to `demo` with views-only Home and My work (opens on Home), Backlog, Sprints and Epics; Backlog has Type, Stage, Owner, Reviewer, Points, Sprint, Epic, Done on, Bucket and Rank, indexed where the views need it; the mockups' sample data with dates relative to the seed day; both root views stored through `parseViewTree` and M4-03's validation, so the seed can't store a tree PUT would refuse; an editor, a viewer and an agent key. The key's secret is generated at seed time and handed to e2e through a gitignored file, never committed. `pnpm seed:large --project` adds a hub of the same shape with 2,000 tasks for the M4-04 and M4-12 budgets. Safe to re-run, and never overwrites a view a hub admin edited.

### Design system

## M4-07 Block presentation components

- **Role:** design-system · **Depends on:** nothing
- **Acceptance:** from the two mockups, in both themes: PageHeader (with the live dot), Section, Columns, NumberStat, GroupedList (up to 4 row fields, two group measures), BoardColumn (with empty text) and BoardCard, BarRows, FieldsInline. Each with D18's states plus "invalid" and "unresolved", and a "No view yet" state (with "Compose" for hub admins). On the kit page and in DESIGN.md. Screens without a mockup (empty, invalid, unresolved and "No view yet" states, and the composer) flagged for the maintainer.

## M4-08 Burndown chart

- **Role:** design-system · **Depends on:** nothing
- **Acceptance:** a small hand-written SVG component like the mockup's, no chart dependency (BarRows in M4-07 covers the bars): burndown with actual, dashed ideal and "Today", stepping over the days Q7 decides; colours from CSS tokens, so it follows the theme (D39) without a rebuild; a hidden data table for screen readers; no task over 50 ms while rendering on a production build.

### Frontend

## M4-09 View renderer, layout and content blocks

- **Role:** frontend · **Depends on:** M4-01 (branch shapes), M4-07; M4-05 for real data
- **Acceptance:** the web block registry; HubPage opens on the hub's "Opens on" folder and renders the folder's root view or the default (identical to today); loads view and data with `version` and the browser's `tz`, subscribes from `seq`, refreshes per block (Q9, including the midnight refetch), reloads on a `hub` event or a 409 `stale`; `page`, `section`, `columns`, `heading`, `text`; one broken block never breaks the page. The sidebar (#231) shows "Views only" and the folder menu (#233) hides "New item" for views-only folders. A queued 429 retries silently. Test: two tabs of the same person both render home with no error state.

## M4-10 Data blocks

- **Role:** frontend · **Depends on:** M4-09, M4-08
- **Acceptance:** `table`, `list`, `board`, `number`, `chart`, `fields`; row and card fields with empty text and option dots; board column subsets and empty columns; group measures; actor names resolved from the member list; create in the binding's folder with presets (Q3), hidden without `item.write`; opening an item uses the existing panel or page; updates in place from the store.

## M4-11 Root view composer

- **Role:** frontend · **Depends on:** M4-03, M4-09 (M4-10 for the preview)
- **Acceptance:** Q10, hub admins only; 422 errors shown at their paths; a test fails if a block type has no form; "Opens on" and the views-only option in hub settings. Tests: a viewer and an editor see no composer; the composed "New item" creates in the binding's folder with the group value preset.

### QA and lead

## M4-12 Blocks end-to-end suite and exit check

- **Role:** qa · **Depends on:** M4-05, M4-06, M4-10, M4-11, #228
- **Acceptance:**
  1. After `pnpm seed`, project home and my work: every number, chart series, board count, group summary and field is checked against `/aggregate` and `/query` for the same binding, and a few against literal values computed from the seed data (for example "16 of 34", "day 6 of 10").
  2. Two people see different "my work"; a viewer sees the views without "New item"; "New item" in My work creates in Backlog and appears in the view; an agent key's create through the API in a views-only folder is refused; "New item" on the Work board sets only Stage; two tabs of the same person both render home with no error state.
  3. An agent key patches a task over HTTP; within 2 s both browsers show the card's new column, the updated numbers, burndown and team row. Creates and deletes appear and disappear. Editing the sprint's dates refetches the burndown.
  4. A hub admin builds "my work" in the composer from the default view, saves, and it renders; a stale tab gets the 409; editor and viewer see no composer.
  5. Removing an attribute a block uses breaks only that block.
  6. On a production build: project home within 1 s seeded and 2 s on `seed:large --project`'s 2,000 tasks, also while 15 agent keys write at D75's rate with two browsers open; no task over 50 ms while the chart renders.
  7. Screenshots of both views in both themes on the PR, with the Q8 differences listed.

## M4-13 M4 report

- **Role:** lead · **Depends on:** all · **Acceptance:** `docs/reports/M4.md` in the M3 format, including the backend track.

### Backend track and carry-overs (already filed)

| Issue | Role | Depends on | When |
| --- | --- | --- | --- |
| #199 contracts and migration (owns `$now`) | backend | – | in progress (gated) |
| #185 long sort cursors | backend | – | in progress (gated) |
| #238 item panel scroll | design-system | – | in progress |
| #244 feed test flake | backend | – | wave 1, while the gate batch waits |
| #229 sign-in limit | backend | Q11 (approved) | wave 1, while the gate batch waits |
| #223 rich text draft | frontend | – | wave 1 |
| #200 external keys, #203 preconditions | backend | #199 | wave 2 |
| #221, #222 API parts, #224 | backend | the gate batch | wave 2 |
| #228 e2e production build only when needed | infra | Q11 | wave 2, before M4-12 |
| #202 batch writes | backend | #200, #203 | wave 3 |
| #204 key on the item page | frontend | #200 | wave 3 |

## Sequence (3 agents at a time)

- **Wave 0:** this plan reviewed; the maintainer answers Q1 to Q11, including the D15, D17 and D44 amendments (Q2); D76 to D83 recorded. Done 2026-11-22.
- **Wave 1:** backend runs the M4-00 spike, opens the blocks gate batch (M4-01, M4-02, on #199's branch if it hasn't merged), then #244 and #229 while it waits; design-system #238, then M4-07, then M4-08; frontend #223, then M4-09 against the batch branch's shapes.
- **Wave 2 (batch merged):** backend M4-03, M4-06, M4-04, then M4-05; a second backend slot (when design-system frees one) on #200, #203, #221/#222 API parts, #224; frontend finishes M4-09 on real data, then M4-10.
- **Wave 3:** backend #202; frontend M4-11 and #204.
- **Wave 4:** QA M4-12 (after #228); the lead writes M4-13.

Critical path: the gate batch review, then M4-03, M4-06, M4-05, M4-10, M4-12.

## Deferred (not needed for the exit)

`tabs`, `divider`, `image`, `document`, `comments`, `activity` blocks (D15 amended); selection bindings; board drag and drop; the rollup attribute type (D44 amended); patch by block ID (D17 amended), view history, named or multiple views per folder; cross-hub bindings; two-dimension grouping and other chart kinds; burndown from history; generated sentences in text blocks; a holiday calendar; the Team folder and its status line; releases.
