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

## Current milestone

**M0, first look.** Exit criteria: CI is green on `main`, `pnpm dev` runs the API and web app against a local Postgres, the dashboard shows hubs and a table of items, and the team's own issues are visible inside a local "Build" hub. Full list in `docs/ROADMAP.md`.

## Rules that always apply

- **Trunk-based.** One issue, one short-lived branch, one pull request. Nothing is pushed straight to `main` after the first commit.
- **Worktrees.** Every subagent works in its own git worktree under `.worktrees/`, never in the main checkout.
- **Everything is written down.** Each claim, handoff, question, review, and decision is a comment on the issue or pull request, prefixed with the role, for example `**[backend]**`.
- **The reviewer is never the author.** QA adds or extends an end-to-end test for every user-visible feature.
- **Stop for the maintainer** on anything labelled `needs-human`: database migrations, changes to `packages/core` contracts, CI secrets, deployment, licence files, deleting data, and any decision not covered by `docs/DECISIONS.md`.
- **No secrets in the repository.** Use `.env` locally and `.env.example` in git.
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
- `pnpm seed`: load the demo workspaces (`demo`, `acme`). Safe to re-run. Refuses `NODE_ENV=production` without `--force`.
- `pnpm seed:build-hub`: import this repository's GitHub issues into the Build hub in the `team` workspace (needs `gh`).

Still to come in M0: `pnpm e2e` (#12). Keep this list up to date as they land.
