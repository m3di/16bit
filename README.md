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
pnpm seed                 # demo workspaces, hubs, items, and people who can sign in
pnpm seed:build-hub       # optional: this repository's issues in a "Build" hub (needs gh)
pnpm seed:large           # optional: a 50,000-item folder in a `large` workspace
pnpm dev                  # migrations, then the API on :3000 and the web app on :5173
```

On its first run `pnpm dev` copies `.env.example` to `.env`. Every variable is documented there.

If your `.env` predates row-level security (#44), copy `MIGRATION_DATABASE_URL` and the new `DATABASE_URL` from `.env.example`: the API now connects as its own role and refuses to serve as the owner of the tables.

The dashboard asks you to sign in. `pnpm seed` creates these people, all with the password `16bit-dev-password`. **Development only:** the password is public, so never run the seed against a database anyone else can reach. As a backstop, when `NODE_ENV=production` this password is refused at sign-in, as the password of a new account accepting an invite, and by `pnpm account:reset-password`, unless `ALLOW_DEV_PASSWORD=1` is set; only `compose.yaml` sets it, for its local stack.

| Email | Pixel Works (`demo`) | Acme Studio (`acme`) |
|---|---|---|
| `owner@example.com` | owner, hub admin of every hub | owner, hub admin of every hub |
| `mina@example.com` | admin: hub admin of Support, editor of Product and Launch, no grant on the rest | |
| `leo@example.com` | member: editor of Product and Launch, commenter on Support, viewer of Design | |
| `ivy@example.com` | viewer: Product and Launch (her editor grant on Launch acts as viewer) | |
| `noor@example.com` | finance: viewer of Support | |
| `sam@example.com` | | finance: viewer of Operations |

On its first run, `pnpm seed` also creates an agent key (Triage bot, editor of Product in Pixel Works) and prints its secret once; send it as `Authorization: Bearer <secret>`. Later runs don't show it again: revoke the key and make a new one through the API if you lose it. The Launch hub has an attribute of every M1 type. `pnpm seed:build-hub` makes `owner@example.com` the owner of the `team` workspace.

The M0 development key and the anonymous dev owner are gone (D41 retired in #51). If your `.env` still sets `DEV_API_KEY`, `DEV_PRINCIPAL_ID` or `DEV_ANONYMOUS_*`, delete them; nothing reads them.

**Only Docker.** `docker compose up --build` builds the image and starts the whole stack: Postgres, migrations, then the API and the built dashboard on http://localhost:8080 (`APP_PORT` changes the port). No Node.js needed. Load demo data with `docker compose run --rm migrate node src/seed.ts --force` (the `migrate` service, because it connects as the owner of the tables and the app never does; `--force` because the image runs with `NODE_ENV=production`; this database is your local one). Then sign in as one of the people above. The seed's password is public, so the port stays bound to 127.0.0.1, and compose sets `ALLOW_DEV_PASSWORD=1` so the production-mode image accepts it. Never set that variable on a deployment. This stack is for trying the app; for working on it, use `pnpm dev`.

**Without Docker.** Create a database in your own Postgres, set `MIGRATION_DATABASE_URL` (a user that may create tables and roles) and `DATABASE_URL` (the API's login role) in `.env` (or export them in your shell, which takes precedence), and run `pnpm dev`. `pnpm db:migrate` creates the API's role from `DATABASE_URL` if it does not exist.

| Command | What it does |
|---|---|
| `pnpm dev` | Waits for Postgres, runs migrations, starts the API and the web dev server. Ctrl-C stops both. |
| `pnpm db:migrate` | Runs migrations only. |
| `pnpm seed` | Runs migrations, then loads two demo workspaces whose hubs cover every size-meter step (0 to 1,200 items), the people above with their hub grants, one agent key (secret printed on the first run only), and a Launch hub with every M1 attribute type. Safe to run again: nothing is duplicated, and existing rows are left as they are, except that the dev owner is made owner again and hub admin of every seeded hub (owners see nothing inside a hub without a grant, D45), and seeded people without an account (from an M0 database) are linked to theirs. Grants are added only where a person has none, and a password you reset is kept. Each hub's first text attribute is its title (D50), set only on a hub nobody has edited in settings, so a title you change or clear stays. Refuses to run when `NODE_ENV=production` unless you pass `--force`. |
| `pnpm seed:build-hub` | Imports this repository's GitHub issues into the "Build" hub of a local `team` workspace, one item per issue, owned by `owner@example.com`. Needs `gh` signed in. Refuses `NODE_ENV=production` unless you pass `--force`. Re-running updates items in place; GitHub wins over local edits of imported values, and items you delete stay deleted. So do the hub and its attributes: a deleted attribute is not re-created and its values are not imported, and with the hub deleted nothing is imported and `gh` is not called; a deleted hub only comes back on a fresh database. Title is the hub's title attribute (D50) unless you have edited the hub in settings. An issue the hub rejects (version conflict, invalid value) is listed at the end and the rest still import; the command then exits non-zero. |
| `pnpm seed:large` | Runs migrations, then creates a `large` workspace owned by `owner@example.com` with a Large hub (prefix `LRG`) whose folder "All items" holds 50,000 items: an attribute of every M1 type, six of them indexed, deterministic values, relations to earlier items, and one revision per item. Takes about ten seconds. Safe to run again: only items never created before are added, so items you delete stay deleted, and attributes or options you delete are left out. With the hub deleted nothing is written. Refuses `NODE_ENV=production` unless you pass `--force`. |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | The checks CI runs. `pnpm test` needs Postgres at `MIGRATION_DATABASE_URL`; API integration tests create and drop a throwaway database there, and run the API as the role in `DATABASE_URL`. |
| `pnpm account:reset-password <email>` | The operator's password reset (D42); the API has none. In a terminal it generates a password and prints it once; with a password piped on stdin (`echo 'new password' \| pnpm account:reset-password <email>`) it sets that one. Ends every session of the account. Refuses the seeds' development password when `NODE_ENV=production`, unless `ALLOW_DEV_PASSWORD=1`. |
| `pnpm e2e` | Playwright end-to-end tests in `e2e`, also run in CI. Needs a migrated and seeded database (`pnpm seed`, and `pnpm seed:large` for the large-folder spec). Reuses a running `pnpm dev`, or starts the API and web app itself. Signs each seeded person in once before the specs run; specs default to the owner's session. The role-matrix specs in `e2e/tests/roles` act as each seeded person, invite people of their own (removed again when a test ends), create and revoke their own agent keys, and create hubs named `Zz e2e …`, which stay because M1 cannot delete hubs. One-time setup: `pnpm --filter @16bit/e2e exec playwright install chromium`. If port 5173 is taken, set `E2E_WEB_PORT`; set `E2E_BASE_URL` to test an app that is already running elsewhere. The timing budgets (`budgets` project, D61) run against the production build: the suite builds the web app and serves it from a second API process on port 3001 (`E2E_BUILT_PORT`), or from `E2E_BUDGETS_BASE_URL` when set. Each test creates its own items, in the seeded workspaces. |
| `docker compose up --build` | Builds the image and runs the whole stack on :8080. |
| `docker compose down` | Stops Postgres (and the app, if running). Add `-v` to delete its data. |

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
