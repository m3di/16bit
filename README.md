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

The quick-start commands are written by the build team during M0 and will appear here once `pnpm dev` works.

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
