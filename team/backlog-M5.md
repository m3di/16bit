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

**Changes after the third review (#317):** the API has no general rate limiter, so Q3 lists only the limits that exist; the team scripts check `current_database()` is `sixteenbit_team`, and the dev-side `seed:build-hub` is removed (Q5). Optional points taken: the issues folder is mounted alone and read-only, `localhost:8090` is allowed, and the per-agent tools check is manual.

**Changes after the second review (#317):** no marker header (Q4; the limits are as the third review says); `team:up` builds from a clean worktree of `origin/main` and fails closed without a backup; every team script runs in the team stack's own container and refuses the dev database, issues are fetched on the host, and the maintainer owns `team` (Q5); agent `tools:` lists gain their own server and the helper runs from the repository root (Q7); `team:restore` is a deletion and needs the maintainer's yes (Q5); #208's issue body is corrected. Optional points taken: `MCP_ALLOWED_HOSTS`, the team stack's own passwords, and D86 noting the digest's optional `version`.

**Changes after review (#317):** the SDK is v2, not v1 (Q3); the team hub gets its own stack and database, apart from the dev one (Q5); the backup dumps the whole team database (Q5); the Build hub has one Tasks folder with a Sprint relation, since items never move between folders and agents can't create folders or edit views (Q6, M5-03); per-role keys are hygiene, not a security boundary, and keys reach Claude Code through a `headersHelper` (Q7); `/mcp` refuses the trusted header and checks `Origin` and `Host` (Q3, Q4); named issues are held back for the exit run (Q8); dependencies fixed; the digest cites D83 and takes `tz` (Q2); answers are recorded as D86 onward (Q9). From the optional points: one rate-limit count per tool call (Q4); role servers declared in each agent file, not in `.mcp.json` (Q7); no `ALLOW_DEV_PASSWORD` on the team stack (Q5); wave 2 is ordered; GitHub issues are closed in one batch after a dry run (Q6).

**Already decided for M5 (maintainer, 2026-11-28):**
- From the M4 report:
  - #307, #276 and #301 move into M5, and #307 goes first (it is in progress).
  - The Team block stays a list.
  - The unscheduled follow-ups stay unscheduled.
- The maintainer looked at the parts with no mockup and asked only for a plus icon on "New item" (#315, in progress).

## Decisions (were open questions)

**Decided by the maintainer on 2026-11-28, all as proposed** (PR #317). They are recorded as D86 onward in #205's PR. Each **Decide** below was a choice the plan couldn't make alone.

**Q1. The #205 batch (D67, D69 to D72).** **Decide:** accept #205's five flagged proposals as written:
- neighbours: the route, depth at most 2, the node cap of 100 by default and 500 at most, and `hidden` counted but never named;
- freshness: `freshFor` from 1 minute to 366 days, and `is_stale` true for an empty or old value;
- search: `q` of 2 to 200 characters, substring matching that ignores case, title matches first, `limit` at most 50;
- the template format, version 1, where import always creates a new hub;
- `account.external_login` with invites by external login.

The contracts and migrations stay one gated PR. The trusted-header sign-in itself (#213) is gated again on its own.

**Q2. The digest (D21, D69, D83).** **Decide:** a digest is a folder's root view rendered as compact text for a model to read. It is D83's view data turned into Markdown, so an agent gets in one call what a person sees on the page.
- **Route:** `GET /v1/workspaces/:w/folders/:folderId/view/digest?version=&tz=`, keyed by folder like the view data route. The ARCHITECTURE row is amended to match.
- **Same rules as view data (D83):**
  - one snapshot and the 5 s deadline;
  - the shared in-flight count of 4 per principal;
  - 409 `stale` when `version` is given and the tree has moved;
  - row-level security.
- **Time zone:** `tz` as in D81, UTC when absent, and 422 for an unknown zone.
- **Response:** `{ seq, version, markdown, truncated }`.
- **Rendering, block by block:**
  - headings and section titles become Markdown headings;
  - a number block becomes "Points done: 16 of 34";
  - list and table rows become `- PT-12 Title · Stage: In QA · Points: 3`;
  - a board becomes one list per column;
  - a chart becomes a small table of its series;
  - a block's error or invalid state becomes one line saying so;
  - "+N more" is kept, and a stale date gets ` (stale)` (D69).
- **Size:** capped at 32 KiB. Past that, it cuts at a block boundary and sets `truncated`.
- **Contract:** the digest shape goes into #205.

**Q3. MCP transport and sign-in.** **Decide:**
- **Transport:** the MCP server is part of the API process, at `POST /mcp`, over Streamable HTTP, stateless (the 2026-07-28 revision).
  - It uses the official TypeScript SDK v2, the current stable line: `@modelcontextprotocol/server` 2.4.0 and `@modelcontextprotocol/fastify` 2.0.1, checked on npm on 2026-11-28. v1 (`@modelcontextprotocol/sdk`) is the maintenance line and stops at the 2025-11-25 spec.
  - Clients that still open with an `initialize` handshake, Claude Code among them, get the SDK's backward-compatible answer, and a test proves Claude Code's handshake connects.
  - There is no stdio server.
- **Sign-in:** only agent keys, as `Authorization: Bearer`.
  - A session cookie is refused with 401, since people use the UI. D49 still refuses both together.
  - The trusted identity header (D72, #213) is never accepted on `/mcp`, whatever the proxy allowlist says.
- **Origin and Host:** `/mcp` checks them as the MCP spec asks. A request with a browser `Origin` that isn't the app's own is refused, and `Host` must be one the server is configured for, against DNS rebinding.
- **Limits:** the API has no general rate limiter today, only the sign-in limiters and D83's in-flight count. Each tool call's inner request goes through the body limit, D83's count and the deadline exactly as over HTTP. A general rate limiter would be a new decision, and it would count the outer `/mcp` request.
- **Host allowlist:** a setting, `MCP_ALLOWED_HOSTS`, which for the team stack includes `127.0.0.1:8090` and `localhost:8090` (the container listens on 3000).

**Q4. The tool set (D22).** **Decide:** one tool per route, not one generic `call` tool.
- **How a tool runs:** through its HTTP route in process (Fastify `inject`), so `can()`, row-level security, limits and error bodies are exactly the HTTP ones. "Mirrored" then stays true by construction.
- **The inner request** carries only headers the server builds: the caller's `Authorization` and the content type. No header from the outer request is copied, so nothing a client sends can reach the route except the tool's arguments.
- **Wave 1 tools:** `describe_hub`, `get_items`, `get_item_by_key`, `query_items`, `aggregate`, `read_view`, `get_changes`, `create_item`, `patch_item`, `delete_item`, `upsert_item`, `batch_write`.
- **Later in M5:** `digest`, `neighbours`, `search`, `claim_item`, `renew_claim`, `release_claim`.
- **Inputs:**
  - the route's core Zod schema, as JSON Schema;
  - no `workspaceId` or `hubId`, because an agent key belongs to exactly one hub (D28) and the server fills them in;
  - `clientMutationId` and `cause` are accepted on every write.
- **Results:** the HTTP JSON as `structuredContent`, with the same text alongside. An error status is `isError: true` with the API's error body, so a 409 `conflict` or 412 `precondition_failed` reads the same as over HTTP.
- **Contract:** the tool names and input schemas are a core contract (`packages/core/src/mcp.ts`), so they join #205.

**Q5. Where the team's hub lives.** **Decide:** a separate local stack just for the team, apart from the dev stack.
- **Today's problem:** `pnpm dev` and the :8080 stack share one `db` service and volume, and `pnpm dev` runs migrations on start. An agent's worktree with an unmerged migration would migrate the team's working hub.
- **The team stack:**
  - its own compose project, `16bit-team`, with its own `team-db-data` volume;
  - bound to 127.0.0.1 on :8090, with its database not published;
  - built only from `origin/main`: `pnpm team:up` fetches, refreshes a clean detached worktree `.worktrees/team-build` at `origin/main`, and builds the image from there, never from the lead's checkout;
  - its own database passwords, in gitignored `.env.team` (with `.env.team.example` in git), not the ones in `compose.yaml`;
  - no `ALLOW_DEV_PASSWORD`;
  - its containers keep the 2 CPU and 3 GB caps, and it stays light while idle.
- **One way in:** every team script runs inside the team stack's own `migrate` container (`docker compose -p 16bit-team run --rm migrate …`), whose database URL comes from the team compose file. No team script reads `.env` or `MIGRATION_DATABASE_URL` from the host, and each one refuses to run unless `current_database()` is `sixteenbit_team`, the database name only the team stack uses (`POSTGRES_DB`). The dev-side `seed:build-hub` is removed, since the team hub no longer lives in the dev database; the Build hub for dev testing is the team seed's fixture. So nothing can write the team data into the dev database, or the other way round.
- **GitHub issues** are fetched on the host with `gh issue list --json` into `backups/issues/`, and only that folder is mounted into the container, read-only. The image never needs `gh`.
- **Owner:** the maintainer owns the `team` workspace. `pnpm team:owner <email>` creates that account in the team database, and the maintainer types its password at the prompt. `DEV_OWNER` is not created there.
- **Backup:** `pnpm team:backup` writes `pg_dump -Fc` of the whole team database to `backups/` (gitignored, since it holds key hashes and sessions).
  - The lead runs it at the end of every sprint pass.
  - `team:up` runs it before every rebuild and fails closed: no backup, no rebuild.
  - `pnpm team:restore <file>` replaces the team data, so it is deleting data: it runs only on the maintainer's yes, takes a fresh backup first, and asks to type the workspace name before going ahead.
- **Not chosen:** a hosted instance, which waits for deployment in M7.

**Q6. What moves into the hub, and what stays on GitHub.** **Decide:**
- **The hub's shape** respects D4 (items never move between folders) and D47 and D78 (agents create no folders and edit no views):
  - one **Tasks** folder, where every task stays for good;
  - a **Sprints** folder, with one item per sprint and its dates;
  - a views-only **Board** folder, whose root view finds the current sprint by a first-match rule (D79) and shows its tasks by stage, plus items needing the maintainer.
- **Each task holds its state:** title, Sprint (a relation), role, stage, depends on (a relation), owner, reviewer, the claim (Q7), the PR URL, and a "Needs maintainer" flag for gated work.
- **Questions:** a question to the maintainer is a write with a cause note (D63), and the lead brings it to the conversation as today.
- **Stays on GitHub:** pull requests, CI, code review comments and QA verdicts. Without comments in M5, discussion stays on the PR.
- **M6:** comments arrive, and the rest of the discussion moves into the hub.
- **16bit never syncs with GitHub.** There is no bridge inside 16bit (D74). The lead imports with a seed script and nothing else.
- **Existing issues:**
  - The lead imports the open ones, keyed by issue number (D64), then shows the maintainer a dry-run list of what will be closed.
  - After the maintainer's yes, they are closed in one batch with a comment "Moved to the team's Build hub as BLD-n". That can be undone, and the issues stay public as a record.
- **Outside contributors:** new outside issues are still welcome (D38). The lead imports them, and the issue stays open until its PR merges.
- **Labels and milestones:** `stage:*`, `role:*` and milestones are no longer kept on GitHub after the switch. `needs-human` stays on PRs.

**Q7. One identity per role.** **Decide:**
- **Keys:** each role (lead, backend, frontend, design-system, infra, qa, reviewer) gets its own editor agent key on the Build hub, so the hub's history says who did what (D9). `pnpm build-hub:keys` creates or rotates them into gitignored `.env.build-hub`.
- **Config:** each agent file in `.claude/agents/` declares its own role's server inline (`mcpServers`, type `http`, `http://127.0.0.1:8090/mcp`). Its `headersHelper` is a small script that reads only that role's key from `.env.build-hub` and prints the `Authorization` header.
  - Keys stay out of the process environment, and a rotated key is picked up on the next 401 without a restart.
  - Each agent file's `tools:` list also gains its own `mcp__build-<role>__*`, and never `mcp__build-lead__*`. Subagents otherwise inherit the lead's servers from `.mcp.json`.
  - The lead's server is in the project `.mcp.json`. Declaring the role servers inline keeps the lead from loading every role's tools.
  - A `headersHelper` runs from the session's working directory, so the script and `.env.build-hub` live in the main checkout, and Claude Code is started at the repository root.
  - Project servers need a one-time approval in Claude Code, which the maintainer gives.
- **Not a security boundary:** this is hygiene. Every agent can run shell commands and could read `.env.build-hub`. The per-role keys make honest mistakes visible in the history and keep one agent from writing as another by accident. Against a misled agent, the protection is still D28: every key is limited to this one hub, as an editor.
- **Claims:** a claim is D68 over two ordinary attributes, "Claimed by" (a person or agent) and "Claimed until" (a date, `freshFor` 2 hours). It is the sprint's guard against two agents taking one task.

**Q8. The exit run.** **Decide:** a real sprint run from the hub, with work held back for it.
- **The held-back issues:** #206 (neighbours), #209 (the stale flag UI), #212 (template settings UI), #276 and #301. They are not started before the switch, so the exit run has real backend, frontend and design-system work in it.
- **How it runs:** after M5-04, these are worked only through the hub. Agents claim, update and finish their tasks with MCP tools, and the lead runs `/standup` and `/sprint` from the hub's Board digest.
- **The record:** the M5 report shows that sprint's hub history. QA's e2e (M5-05) checks the same loop against a test hub in CI.

**Q9. Recording the answers.** Q2 to Q8 are recorded in `docs/DECISIONS.md` as D86 onward. The digest's `version` is optional, unlike D83's required one; D86 says so. Q1 amends the detail of D67 and D69 to D72, as #199 did for D64 to D66.

## Issues

### Gate batch (maintainer review)

## #205 M5 contracts and migrations (already filed, extended)
- **Role:** backend · **Gate:** needs-human
- **Adds to the existing acceptance:**
  - the digest response and query (Q2);
  - `packages/core/src/mcp.ts`, with the tool names and input schemas (Q4);
  - ARCHITECTURE: the digest route, the `/mcp` endpoint and the search row (M5, D70).
- D86 onward are recorded in the same PR.

### Backend

## M5-01 MCP server and the wave 1 tools
- **Role:** backend · **Depends on:** #205
- **Acceptance:**
  - `POST /mcp` as Q3 says, with SDK v2 pinned.
  - The 12 wave 1 tools in Q4, each run through its route by `inject`, with only server-built headers.
  - Agent keys only:
    - a cookie is refused;
    - D49 holds;
    - the trusted header is refused even from an allowlisted address;
    - `Origin` and `Host` are checked.
  - Tests through the SDK's own client:
    - list the tools;
    - each tool's success and its main error statuses (404 hidden, 409, 412, 422);
    - a write's `clientMutationId` replays;
    - a viewer key refused on writes;
    - D83's in-flight count applies to `read_view` calls as it does over HTTP;
    - a request from the network can't reach a route's handler with headers the tool didn't build;
    - an `initialize` handshake as Claude Code sends it.
  - The README says how to point an MCP client at a local stack.
  - ARCHITECTURE describes the server.

## #208 Freshness: `is_stale` filter (filed) · **Depends on:** #205
The digest marker moves to M5-02, so #208 no longer depends on the digest. The issue body is corrected.

## M5-02 Digest read and tool
- **Role:** backend · **Depends on:** #205, M5-01, #208
- **Acceptance:**
  - The route and rendering in Q2, from the view data code path, so it can't disagree with the page.
  - The `digest` tool.
  - Tests:
    - each block type renders, including error and invalid states;
    - "+N more" and ` (stale)` are kept;
    - the 32 KiB cut at a block boundary;
    - `tz`, 422 and 409 `stale`;
    - the in-flight count shared with view data;
    - a hidden folder gives 404;
    - one golden digest of the seeded Parcel Tracker home.

## #207 Claim, renew and release MCP tools (filed) · **Depends on:** #205, M5-01
## #210 Basic search over titles and text (filed) · **Depends on:** #205. Adds the `search` tool once M5-01 is in.
## #211 Hub template export and import: API (filed) · **Depends on:** #205
## #213 Trusted-header sign-in (filed) · **Depends on:** #205 · **Gate:** needs-human, again on its own. Acceptance adds: never on `/mcp`.
## #206 Neighbours read and MCP tool (filed) · **Depends on:** #205, M5-01 · held for the exit run (Q8)

### Infra and lead

## M5-03 The team stack and the Build hub
- **Role:** infra, with backend for the seed · **Depends on:** #205, M5-01, #207, #208
- **Acceptance:**
  - The team stack in Q5: `pnpm team:up`, `team:backup`, `team:restore` and `team:owner`, all through the team `migrate` container.
  - A new `pnpm team:seed` (replacing `seed:build-hub` in `package.json`, `apps/api/package.json`, `README.md`, `.env.example`, `CLAUDE.md` and `docs/ARCHITECTURE.md`) builds the team's working hub. The `current_database()` check sits in each script's entry point, so tests can still seed a throwaway database:
    - the shape in Q6, plus the Q7 claim attributes;
    - each issue's number as its external key, so a re-run upserts instead of duplicating;
    - a dry-run mode that lists what it would create and change.
  - The "Board" root view.
  - `pnpm build-hub:keys` and the `headersHelper` script (Q7).
  - `.gitignore` re-includes `.env.build-hub.example` and `.env.team.example`, and ignores `backups/`.
  - CLAUDE.md commands updated.
  - Tests:
    - the seed is idempotent;
    - keys rotate, and the old key stops working;
    - a backup restores into a fresh database;
    - the team stack and the dev stack share no volume;
    - each team script refuses the dev database, and the dev scripts never reach the team one;
    - `team:up` refuses to rebuild when the backup fails;
    - (manual, recorded in M5-04's PR, since it can't run in CI) each subagent sees only its own role's server tools.

## M5-04 Switch the team's workflow to the hub
- **Role:** lead · **Depends on:** M5-03, M5-02
- **Acceptance:**
  - `docs/WORKFLOW.md`, `CLAUDE.md`, `/standup` and `/sprint` read the board from the hub through MCP. The digest of "Board" is the standup.
  - Claims, stage moves and handoffs are writes with a cause.
  - Each agent file declares its own role's server (Q7).
  - The open GitHub issues are imported, then closed in one batch after the maintainer's yes on the dry-run list (Q6).
  - Reviewed like any PR.

### Frontend

## #307 (carried over) · in progress, first
## #209 Freshness: stale flag in the table and on the item page (filed) · **Depends on:** #208 · held for the exit run (Q8)
## #212 Hub template export and import: settings UI (filed) · **Depends on:** #211 · held for the exit run (Q8)
## #276 (carried over) · held for the exit run (Q8)

### Design system

## #301 PageHeader heading level (carried over) · held for the exit run (Q8)
## #315 Plus icon on "New item" · done (#316)

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
  - This plan is reviewed, and the maintainer answers Q1 to Q9.
  - #205 is extended, built, and merged after the maintainer's yes.
  - Already running: #307.
- **Wave 1 (backend, 3 at once):** M5-01, #208 and #210. Then #211 when one of them finishes.
- **Wave 2, in this order:**
  1. #207 and M5-02, which need M5-01 and #208;
  2. #213, once its own gate is passed;
  3. M5-03, after #207;
  4. M5-05, after #207 and M5-02.
- **Wave 3:** M5-04 switches the team to the hub. The exit run follows: #206, #209, #212, #276 and #301 are worked only through the hub (Q8).
- **Wave 4:** the M5 report, then stop for the maintainer.
