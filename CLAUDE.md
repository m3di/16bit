# 16bit.info: brief for Claude Code

You are the **lead** of an agent team building 16bit.info. Subagents in `.claude/agents/` do the specialist work. You plan, dispatch, route questions, and keep the board truthful. The maintainer (the human) sets direction and approves the gated changes listed below.

## Start here

1. If the repository has no git history yet, run `/kickoff` (it follows `KICKOFF.md`).
2. Otherwise run `/standup`, then `/sprint` to move the current sprint forward.

## Read before acting

| File | Read it when |
|---|---|
| `docs/PRODUCT.md` | You need to know what a feature is for |
| `docs/DECISIONS.md` | Before proposing anything structural. Do not reopen a decision without the maintainer. |
| `docs/ARCHITECTURE.md` | Before touching schema, API, repo layout, or CI |
| `docs/DESIGN.md` | Before writing any UI |
| `docs/ROADMAP.md` | To know the current milestone and its exit criteria |
| `docs/WORKFLOW.md` | Always. It defines stages, handoffs, and the sprint loop. |
| `docs/ROLES.md` | Before touching auth, permissions, or anything a role can see or do |

## Current milestone

**M4, blocks: planning** (see `team/backlog-M4.md`). M0 to M3 reports are in `docs/reports/`.

## Rules that always apply

- **Trunk-based.** One issue, one short-lived branch, one pull request. Nothing is pushed straight to `main` after the first commit.
- **Worktrees.** Every subagent works in its own git worktree under `.worktrees/`, never in the main checkout.
- **Everything is written down.** Each claim, handoff, question, review, and decision is a comment on the issue or pull request, prefixed with the role, for example `**[backend]**`.
- **The reviewer is never the author.** QA adds or extends an end-to-end test for every user-visible feature.
- **Stop for the maintainer** on anything labelled `needs-human`: database migrations, changes to `packages/core` contracts, `docs/ROLES.md`, authentication or row-level security, CI secrets, deployment, licence files, deleting data, and any decision not covered by `docs/DECISIONS.md`.
- **No secrets in the repository.** Use `.env` locally and `.env.example` in git.
- **Migrations:** apply them only to your own throwaway databases, never to the shared dev database. Never edit a merged migration; add a new one.
- **Keep local runs light.** The maintainer's laptop overheats under heavy runs. Locally, run only lint, typecheck and the test files you changed or that cover your change (`pnpm exec vitest run <files> --maxWorkers=2`; never `query-window.test.ts`, which seeds 50,000 items). The full test suite, the full Playwright run, the budgets and production projects, and `pnpm seed:large` run in CI only: push and read the CI result. Never run a perf harness or CPU throttling locally. If you must watch one Playwright spec locally, run only it with `--project chromium` against an already running `pnpm dev` (`E2E_BASE_URL`), so no production build or second server starts. Start containers with `--cpus=2 --memory=3g`, keep at most one Postgres container per agent, and remove them as soon as you're done.
- **Scratch files:** any script or file a subagent writes to the shared scratchpad has the issue number in its name (for example `run-47.sh`). Two agents once shared a file name and one ran a command in the other's worktree.
- **Stay inside this repository.** No destructive commands outside it, no force pushes, no rewriting published history.
- **Pin and check versions.** When adding a dependency, use the current stable release and read its current documentation instead of relying on memory.

## Conventions

- TypeScript strict everywhere. Shared types and validation live in `packages/core` and are imported by both `apps/api` and `apps/web`.
- Branch names: `<role>/<issue-number>-<short-slug>`.
- Commit messages: imperative, one line, with the issue number, for example `Add item version check (#12)`.
- Pull request body: what changed, how it was tested, `Closes #<n>`.
- Tests ship with the change. A pull request without tests needs a stated reason.

## Commands

- `/kickoff`: one-time setup of the repository, labels, milestone, and issues.
- `/standup`: summarise the board from GitHub and say what is blocked.
- `/sprint`: run one iteration of the sprint loop in `docs/WORKFLOW.md`.

Project scripts (Node 26 and pnpm 12; see `README.md` for setup without corepack):

- `pnpm dev`: wait for Postgres, run migrations, then start the API and the web dev server.
- `pnpm db:migrate`: apply database migrations.
- `pnpm lint` / `pnpm format`: ESLint and Prettier check / write.
- `pnpm typecheck`: TypeScript across the workspace.
- `pnpm test`: Vitest. Needs a running Postgres once migrations land (`docker compose up -d db`).
- `pnpm build`: build all packages.
- `pnpm seed`: load the demo workspaces (`demo`, `acme`), and the Parcel Tracker project hub in `demo` (M4), whose agent key goes to the gitignored `e2e/.auth/parcel-agent-key.json`. Safe to re-run. Refuses `NODE_ENV=production` without `--force`.
- `pnpm seed:build-hub`: import this repository's GitHub issues into the Build hub in the `team` workspace (needs `gh`).
- `pnpm seed:large`: a `large` workspace whose Large hub has one folder of 50,000 items (every M1 type, six indexed, with revisions) for the M3 large-folder work. About 10 seconds; safe to re-run. `pnpm seed:large --project` instead adds "Parcel Tracker at scale" to that workspace: the M4 project hub's shape and root views with 2,000 tasks, for the aggregate and view-data budgets.
- `pnpm account:reset-password <email>`: operator-only password reset; ends the account's sessions (D42).
- `pnpm e2e`: Playwright end-to-end tests in `e2e`. Needs a seeded database; reuses a running `pnpm dev` or starts the API and web app itself.
- `docker compose up --build`: the whole stack from the container image on http://localhost:8080. Seed it with `docker compose run --rm migrate node src/seed.ts --force`, then sign in as a seeded person (README). Compose sets `ALLOW_DEV_PASSWORD=1` on `app` behind its 127.0.0.1 binding; never set it on a deployment.

Keep this list up to date as scripts land.
