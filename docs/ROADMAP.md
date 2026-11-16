# Roadmap

## Goal

A deployable web app, backed only by Postgres, where people and agents share structured data through a fast API and a real-time dashboard. The team that builds it moves its own coordination into it as soon as it can.

Each milestone ends with something the maintainer can open and judge. The team stops at the end of each one and waits for feedback.

## M0: first look

The smallest thing that proves the shape: a green pipeline, a running app, and visible agent collaboration.

**Exit criteria**

1. CI is green on `main`: lint, typecheck, unit tests, build, and an end-to-end smoke test.
2. `pnpm dev` starts the API and web app against a local Postgres. `docker compose up` starts the whole stack.
3. The API can create, read, update, and delete items in a folder, validates values against the folder's attributes, and returns 409 on a version conflict.
4. The main dashboard lists workspaces and their hubs with size meters, in light and dark themes.
5. Opening a hub shows its folders, a table of items, and an item panel where a value can be edited.
6. `pnpm seed:build-hub` imports this repository's issues into a local "Build" hub, so the team's own work is visible inside the product.
7. Every merged pull request shows the trail: claim, implementation notes, review, and test.
8. `docs/reports/M0.md` exists.

**Not in M0:** real authentication, permissions, real time, filters, views other than the table, MCP, comments, rich text, Kubernetes.

## M1: data API and access

Authentication and sessions for people, agent keys scoped to hubs, workspace and hub roles, row-level security, the attribute type set except file and rollup (D44) with `item_index`, filters and sorting in the query endpoint, relations and the `link` table.

*Exit:* two people and one agent key with different roles see and can do exactly what the role matrix (`docs/ROLES.md`) says, proven by end-to-end tests. The dashboard requires sign-in, and D41's anonymous dev owner is gone.

## M2: dashboard and settings

The settings surface: workspace members and roles, hub settings (general, access, folders, attributes). The item page. Design system components completed, with all four states.

*Exit:* a new hub can be created, given attributes and folders, and populated, entirely from the UI.

## M3: sync

The change feed, WebSocket subscriptions, the client store, optimistic writes with rollback, virtual scrolling, chunked loading.

*Exit:* two browsers and one agent editing the same folder stay consistent, and a 50,000-item folder scrolls smoothly.

## M4: blocks

The block registry and root view composer. Blocks: list, board, chart, number, fields, plus layout and content blocks. Set and single-item bindings. Aggregate and view-data endpoints.

*Exit:* the "project home" and "my work" mockups are built as real root views from real data.

## M5: MCP and the dogfood switch

The MCP server with describe, get, query, view, digest, and write tools. The build team moves its backlog from GitHub issues into a 16bit hub and coordinates there from then on.

*Exit:* a sprint is run end to end with the agents reading and writing their tasks through MCP.

## M6: communication

Comments, mentions, reactions, the activity block, rich text with the document block, search.

*Exit:* the "task" mockup is real, and agents hand work to each other through comments on items.

## M7: hardening and deployment

End-to-end coverage for every major function, sharded across runners. Load tests. Container image, migration job, Kubernetes manifests, deploy from `main` to the cluster. Webhooks.

*Exit:* a merge to `main` rolls out to the cluster without manual steps, and the backend scales horizontally under load.

## Later

Gallery, Gantt, calendar, graph, pixel and heat blocks. Formula attributes. Read replicas, caching, sharding. A hosted service.
