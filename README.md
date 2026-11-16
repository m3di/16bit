# 16bit.info

A shared workspace that people and AI agents both read and write.

16bit.info stores structured items in **hubs**, serves them through a fast API (HTTP and MCP), and shows them in a real-time dashboard. An agent's tools and a person's dashboard look at the same data, so whatever an agent writes is visible to the team at once.

> Status: pre-alpha. The repository currently holds the product brief, the roadmap, and the agent team setup. Milestone M0 ("first look") is in progress. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Concepts

| Term | Meaning |
|---|---|
| Workspace | The account boundary. People and agents are members of a workspace. |
| Hub | A top-level folder. A hub is a self-contained domain with its own permissions, attributes, and ID prefix. |
| Folder | A container of items inside a hub. Each folder opens on a root view. |
| Item | A record in exactly one folder. Its values are keyed by attribute. |
| Attribute | A typed field (text, number, select, relation, and so on) defined per hub. |
| View | A tree of blocks (table, board, chart, text, and so on) that presents items. |

## Running it locally

You need Node.js 26 (see `.nvmrc`), pnpm 12, and either Docker or a Postgres you run yourself.

```sh
pnpm install
docker compose up -d db   # Postgres 18 on 127.0.0.1:55432
pnpm seed                 # optional: demo workspaces, hubs, and items
pnpm dev                  # migrations, then the API on :3000 and the web app on :5173
```

On its first run `pnpm dev` copies `.env.example` to `.env`. Every variable is documented there.

If your `.env` predates the items API, add `DEV_API_KEY` and `DEV_PRINCIPAL_ID` from `.env.example`; the API will not start without the key.

**Without Docker.** Create a database in your own Postgres, set `DATABASE_URL` in `.env` (or export it in your shell, which takes precedence), and run `pnpm dev`.

| Command | What it does |
|---|---|
| `pnpm dev` | Waits for Postgres, runs migrations, starts the API and the web dev server. Ctrl-C stops both. |
| `pnpm db:migrate` | Runs migrations only. |
| `pnpm seed` | Runs migrations, then loads two demo workspaces whose hubs cover every size-meter step (0 to 1,200 items). Safe to run again: nothing is duplicated, and existing rows are left as they are, except that `DEV_PRINCIPAL_ID` is made owner again. Refuses to run when `NODE_ENV=production` unless you pass `--force`. |
| `pnpm seed:build-hub` | Imports this repository's GitHub issues into the "Build" hub of a local `team` workspace, one item per issue. Needs `gh` signed in. Re-running updates items in place; GitHub wins over local edits of imported values, and items you delete stay deleted. |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | The checks CI runs. `pnpm test` needs Postgres at `DATABASE_URL`; API integration tests create and drop a throwaway database there. |
| `docker compose down` | Stops Postgres. Add `-v` to delete its data. |

### Installing Node.js and pnpm

Install Node.js 26 with a version manager that reads `.nvmrc` (`fnm use`, `nvm use`) or with `brew install node@26`. `pnpm install` refuses older versions.

Install pnpm with its standalone installer, which needs no Node.js and does not go through corepack:

```sh
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.21.0 sh -
```

Open a new shell, then check that `pnpm -v` prints `12.21.0`. If `pnpm` fails with a missing `bin/pnpm.cjs` or another module error, an older corepack or npm shim is earlier on your `PATH`: run `which -a pnpm`, then remove that shim (`corepack disable pnpm`, or `npm uninstall -g pnpm`).

## How this repository is built

A team of Claude Code subagents builds 16bit.info, coordinated by a lead session and reviewed by the maintainer. The approach is described in [docs/WORKFLOW.md](docs/WORKFLOW.md). Until the product can host its own backlog, the team coordinates through GitHub issues and pull requests.

## Documentation

- [docs/PRODUCT.md](docs/PRODUCT.md): what the product is and who it is for
- [docs/DECISIONS.md](docs/DECISIONS.md): decisions already made, with reasons
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): stack, data model, API, delivery
- [docs/DESIGN.md](docs/DESIGN.md): design system rules and tokens
- [docs/ROADMAP.md](docs/ROADMAP.md): milestones and exit criteria
- [docs/WORKFLOW.md](docs/WORKFLOW.md): how the agent team collaborates

## Contributing

Issues and pull requests are welcome. Only the maintainer merges. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence and name

The code is licensed under [Apache 2.0](LICENSE). The name "16bit.info" and the logo are not covered by that licence. Forks must use a different name. See [TRADEMARK.md](TRADEMARK.md).
