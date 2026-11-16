# Product

## What it is

16bit.info is a hosted data structure with two faces. Agents see a fast, strictly validated read and write API. People see a real-time dashboard over the same data. Nothing is stored twice and nothing needs syncing between the two.

It started as "long-term memory as a service" for agents and widened into a general workspace, because a memory, a backlog, a reading list, and a ticket queue are all the same thing underneath: typed items in folders, presented through views.

## Who it is for

- **A person with agents.** One or more assistants keep notes, tasks, and memory in a hub. The person can open the dashboard and see, edit, and correct what the agents know.
- **A team with agents.** People and agents share hubs such as engineering, support, and roadmap. Agents report, review, and test through the same items the team uses.

## What it must do well

1. **Fast, predictable reads.** Every query is bounded and hits an index. An agent can boot from one cached read.
2. **Safe writes.** Every write is validated against the hub's attributes and carries a version check, so two writers cannot silently overwrite each other.
3. **A dashboard that is never broken.** Real-time, responsive, with every state designed: loading, empty, error, and no permission.
4. **Strict structure, flexible presentation.** The data model is small and closed. Views are composed freely on top of it.

## The model

- A **workspace** is the account boundary. Members are people and agents.
- A **hub** is a top-level folder: a domain with its own permission chain, attributes, and ID prefix. Hubs are guarded against each other.
- A **folder** holds items and opens on a root view. Folders nest inside a hub.
- An **item** lives in exactly one folder. Showing it elsewhere is done with a view or a relation.
- An **attribute** has one of a closed set of types. A folder lists the attributes its items must satisfy.
- A **view** is a tree of blocks. Layout blocks nest. Content blocks hold static text stored in the view. Data blocks read items, either a set (a query) or a single item (fixed, picked by a rule, or bound to another block's selection).
- **Comments** hang on items, never on views.

## The two surfaces

- **Presentation** is what people use day to day. It is solid: no filter bars, no schema controls, and no undesigned state. Each view decides which actions it offers.
- **Settings** is a separate surface for workspace roles, hub access, folders, attributes, and editing root views.

## What it is not

- Not a workflow or automation engine. It emits triggers (a change feed and webhooks). Agents do the acting.
- Not a model host. It runs no language models and stores no prompts on behalf of users.
- Not a free-form database. Users cannot invent types or run code on the server.

## Brand

- The name is 16bit.info. The look borrows lightly from the 16-bit era: a 16-colour palette, pixel avatars generated per person and agent, and small pixel indicators.
- The top-level unit is called a **hub**.
- Positioning: the shared workspace your team and your agents both read and write.
