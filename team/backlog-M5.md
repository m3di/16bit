# Sprint 5 backlog: MCP and agent coordination

The initial plan for M5. Each new entry becomes a GitHub issue once the maintainer has answered the questions. After that GitHub (and, from wave 3, the Build hub) is the source of truth, and this file is not edited.

**Sprint goal:** agents read and write their tasks through MCP. The MCP server mirrors the HTTP read forms and writes (D21, D22). The build team's backlog moves into a 16bit hub, and the last part of M5 is run from that hub, end to end, by the agents (the M5 exit in `docs/ROADMAP.md`).

**What exists today:**
- No MCP server and no MCP dependency.
- No digest. ARCHITECTURE lists `GET /v1/views/:id/digest`, but since D76 views are keyed by folder, so that route shape is out of date.
- `pnpm seed:build-hub` imports this repository's GitHub issues into a local `Build` hub (prefix `BLD`) in the `team` workspace. Nothing reads or writes it after the import.
- Agents already have everything MCP needs underneath:
  - agent keys, one hub each (D28, D47);
  - external keys and upserts (D64);
  - batch writes (D65);
  - preconditions and `$now` (D66);
  - causes on writes (D63);
  - `/changes`.
- Comments arrive in M6, not M5. So in M5 the hub can hold a task and its state, but not a discussion (Q6).

**Already decided for M5 (maintainer, 2026-11-28):**
- From the M4 report:
  - #307, #276 and #301 move into M5, and #307 goes first (it is in progress).
  - The Team block stays a list.
  - The unscheduled follow-ups stay unscheduled.
- The maintainer looked at the parts with no mockup and asked only for a plus icon on "New item" (#315, in progress).

## Questions for the maintainer

Each question gives a proposal. **Decide** marks a choice the plan can't make alone.

**Q1. The #205 batch (D67, D69 to D72).** **Decide:** accept #205's five flagged proposals as written:
- neighbours: the route, depth at most 2, the node cap of 100 by default and 500 at most, and `hidden` counted but never named;
- freshness: `freshFor` from 1 minute to 366 days, and `is_stale` true for an empty or old value;
- search: `q` of 2 to 200 characters, substring matching that ignores case, title matches first, `limit` at most 50;
- the template format, version 1, where import always creates a new hub;
- `account.external_login` with invites by external login.

The contracts and migrations stay one gated PR. The trusted-header sign-in itself (#213) is gated again on its own.

**Q2. The digest (D21, D69).** **Decide:** a digest is a folder's root view rendered as compact text for a model to read. It is the view data (D81) turned into Markdown, so an agent gets in one call what a person sees on the page.
- **Route:** `GET /v1/workspaces/:w/folders/:folderId/view/digest`, keyed by folder like the view data route. The ARCHITECTURE row is amended to match.
- **Response:** `{ seq, version, markdown, truncated }`. It goes through the same checks as view data: the 5 s deadline, the per-principal limit and row-level security.
- **Rendering, block by block:**
  - headings and section titles become Markdown headings;
  - a number block becomes "Points done: 16 of 34";
  - list and table rows become `- PT-12 Title · Stage: In QA · Points: 3`;
  - a board becomes one list per column;
  - a chart becomes a small table of its series;
  - "+N more" is kept, and a stale date gets ` (stale)` (D69).
- **Size:** capped at 32 KiB. Past that, it cuts at a block boundary and sets `truncated`.
- **Contract:** the digest shape goes into #205, so the gate batch stays one PR.

**Q3. MCP transport and sign-in.** **Decide:**
- **Transport:** the MCP server is part of the API process, at `POST /mcp`, over Streamable HTTP, stateless.
  - The 2026-07-28 MCP revision makes the protocol core stateless, and the SDK has a stateless Streamable HTTP mode for API-style servers like this one.
  - It is the official TypeScript SDK. The stable v1 line is pinned to its current release, because v2 is still in beta. The agent checks the version and its current documentation when adding it.
  - There is no stdio server.
- **Sign-in:** only agent keys, as `Authorization: Bearer`. A session cookie is refused with 401, since people use the UI. D49 still refuses both together.
- **Limits:** the same rate limits and request limits as HTTP.

**Q4. The tool set (D22).** **Decide:** one tool per route, not one generic `call` tool. Each tool runs its HTTP route in process (Fastify `inject`), so sign-in, `can()`, row-level security, limits and error bodies are exactly the HTTP ones. "Mirrored" then stays true by construction.
- **Wave 1 tools:** `describe_hub`, `get_items`, `get_item_by_key`, `query_items`, `aggregate`, `read_view`, `get_changes`, `create_item`, `patch_item`, `delete_item`, `upsert_item`, `batch_write`.
- **Later in M5:** `digest`, `neighbours`, `search`, `claim_item`, `renew_claim`, `release_claim`.
- **Inputs:**
  - the route's core Zod schema, as JSON Schema;
  - no `workspaceId` or `hubId`, because an agent key belongs to exactly one hub (D28) and the server fills them in;
  - `clientMutationId` and `cause` are accepted on every write.
- **Results:** the HTTP JSON as `structuredContent`, with the same text alongside. An error status is `isError: true` with the API's error body, so a 409 `conflict` or 412 `precondition_failed` reads the same as over HTTP.
- **Contract:** the tool names and their input schemas are a core contract (`packages/core/src/mcp.ts`), so they join the #205 batch.

**Q5. Where the team's hub lives.** **Decide:** the Build hub lives in the local Docker stack on :8080, in its Postgres volume, as the demo hubs do.
- **Backup:** `pnpm build-hub:backup` writes a `pg_dump` of the `team` workspace to a gitignored `backups/`. The lead runs it at the end of every sprint pass, so losing the volume costs one pass at most.
- **Running:** the stack must be running while a sprint runs. It is light while idle, and its containers keep the 2 CPU and 3 GB caps.
- **Not chosen:** a hosted instance, which waits for deployment in M7.

**Q6. What moves into the hub, and what stays on GitHub.** **Decide:**
- **Into the hub:** each task and its state: title, role, stage, depends on, owner, reviewer, claim (Q7), the PR URL, and a "Needs maintainer" flag for gated work.
- **Questions:** a question to the maintainer is a write with a cause note (D63), and the lead brings it to the conversation as today.
- **Stays on GitHub:** pull requests, CI, code review comments and QA verdicts. Without comments in M5, discussion stays on the PR.
- **M6:** comments arrive, and the rest of the discussion moves into the hub.
- **Existing issues:** the lead imports the open ones with `seed:build-hub`, keyed by issue number (D64). Each imported issue is then closed with a comment "Moved to the team's Build hub as BLD-n". The closing is reversible, and the issues stay public as a record.
- **Outside contributors:** new outside issues are still welcome (D38). The lead imports them, and the issue stays open until its PR merges.
- **Labels and milestones:** `stage:*`, `role:*` and the milestone are no longer kept on GitHub after the switch. `needs-human` stays on PRs.

**Q7. One identity per role.** **Decide:**
- **Keys:** each role (lead, backend, frontend, design-system, infra, qa, reviewer) gets its own editor agent key on the Build hub, so the hub's history says who did what (D9). `pnpm build-hub:keys` creates or rotates them into gitignored `.env.build-hub`.
- **Config:** the repository's `.mcp.json` declares one MCP server per role, such as `build-backend`, each with its key read from the environment. No key ever goes in git.
- **Access:** each agent definition in `.claude/agents/` allows only its own server's tools, so a subagent can't write as another role.
- **Claims:** a claim is D68 over two ordinary attributes, "Claimed by" (a person or agent) and "Claimed until" (a date, `freshFor` 2 hours). It is the sprint's guard against two agents taking one task.

**Q8. The exit run.** **Decide:** the exit run is the last wave of M5 itself. Once the MCP server, the Build hub and the workflow switch have landed (end of wave 2), the remaining M5 issues are worked only through the hub. Agents claim, update and finish their tasks with MCP tools, and the lead runs `/standup` and `/sprint` from the hub. The M5 report shows the hub history of that run. QA's e2e (M5-05) checks the same loop against a test hub in CI.

## Issues

### Gate batch (maintainer review)

## #205 M5 contracts and migrations (already filed, extended)
- **Role:** backend · **Gate:** needs-human
- **Adds to the existing acceptance:**
  - the digest response (Q2);
  - `packages/core/src/mcp.ts`, with the tool names and input schemas (Q4);
  - ARCHITECTURE: the digest route, the `/mcp` endpoint and the search row (M5, D70).

### Backend

## M5-01 MCP server and the wave 1 tools
- **Role:** backend · **Depends on:** #205
- **Acceptance:**
  - `POST /mcp` as Q3 says, with the official TypeScript SDK pinned.
  - The 12 wave 1 tools in Q4, each run through its route by `inject`.
  - Agent keys only; a cookie is refused; D49 holds.
  - Tests through the SDK's own client:
    - list the tools;
    - each tool's success and its main error statuses (404 hidden, 409, 412, 422);
    - a write's `clientMutationId` replays;
    - a viewer key refused on writes.
  - The README says how to point an MCP client at a local stack.
  - ARCHITECTURE describes the server.

## M5-02 Digest read and tool
- **Role:** backend · **Depends on:** #205, M5-01
- **Acceptance:**
  - The route and rendering in Q2, from the view data code path, so it can't disagree with the page.
  - The `digest` tool.
  - Tests:
    - each block type renders;
    - "+N more" and ` (stale)` are kept;
    - the 32 KiB cut at a block boundary;
    - a hidden folder gives 404;
    - one golden digest of the seeded Parcel Tracker home.

## #206 Neighbours read and MCP tool (filed) · **Depends on:** #205, M5-01
## #207 Claim, renew and release MCP tools (filed) · **Depends on:** #205, M5-01
## #208 Freshness: `is_stale` filter and digest marker (filed) · **Depends on:** #205. The digest part lands with M5-02.
## #210 Basic search over titles and text (filed) · **Depends on:** #205. Adds the `search` tool once M5-01 is in.
## #211 Hub template export and import: API (filed) · **Depends on:** #205
## #213 Trusted-header sign-in (filed) · **Depends on:** #205 · **Gate:** needs-human, again on its own

### Infra and lead

## M5-03 The team's Build hub
- **Role:** infra, with backend for the seed · **Depends on:** M5-01, #207
- **Acceptance:**
  - `seed:build-hub` is reworked into the team's working hub:
    - folders Backlog and Sprints, plus a views-only Board;
    - the attributes in Q6 and Q7;
    - each issue's number as its external key, so a re-run upserts instead of duplicating.
  - A root view "Board": this sprint by stage, and items needing the maintainer.
  - `pnpm build-hub:keys` and `pnpm build-hub:backup` (Q5, Q7).
  - `.mcp.json` with one server per role, and `.env.build-hub.example`.
  - CLAUDE.md commands updated.
  - Tests: the seed is idempotent; keys rotate and the old key stops working; the backup restores into a fresh database.

## M5-04 Switch the team's workflow to the hub
- **Role:** lead · **Depends on:** M5-03, M5-02
- **Acceptance:**
  - `docs/WORKFLOW.md`, `CLAUDE.md`, `/standup` and `/sprint` read the board from the hub through MCP. The digest of "Board" is the standup.
  - Claims, stage moves and handoffs are writes with a cause.
  - Each agent definition in `.claude/agents/` allows only its own role's MCP server (Q7).
  - The open GitHub issues are imported and then closed as Q6 says, only after the maintainer's yes on that step.
  - Reviewed like any PR.

### Frontend

## #209 Freshness: stale flag in the table and on the item page (filed) · **Depends on:** #208
## #212 Hub template export and import: settings UI (filed) · **Depends on:** #211
## #307, #276 (carried over) · #307 is in progress and goes first

### Design system

## #301 PageHeader heading level (carried over)
## #315 Plus icon on "New item" (in progress)

### QA and lead

## M5-05 MCP end-to-end and the exit loop
- **Role:** qa · **Depends on:** M5-01, #207, M5-02
- **Acceptance:** a CI spec that drives the MCP server with the SDK client against a seeded test hub, using two agent keys:
  - `describe_hub`;
  - `query_items` for ready tasks;
  - both keys `claim_item` the same task: one wins, and the other gets 412;
  - the winner `patch_item`s the stage with a cause, then `release_claim`s;
  - `digest` shows the new stage;
  - the browser shows the change live within 2 s (M3's check).

## M5-06 M5 report
- **Role:** lead · **Depends on:** everything above
- **Acceptance:** `docs/reports/M5.md`, with the exit run's hub history (Q8).

## Sequence (3 agents at a time)

- **Wave 0:**
  - This plan is reviewed, and the maintainer answers Q1 to Q8.
  - #205 is extended, built, and merged after the maintainer's yes.
  - Already running: #307 and #315.
- **Wave 1:** M5-01, #208, #210, #211 (backend, at most 3 at once), with #276 and #301 alongside.
- **Wave 2:** M5-02, #206, #207, #209, #212, M5-03, and #213 once its own gate is passed.
- **Wave 3:** M5-04 switches the team to the hub. Everything left in M5 runs through the hub (the exit run, Q8), with M5-05 as its CI check.
- **Wave 4:** the M5 report, then stop for the maintainer.
