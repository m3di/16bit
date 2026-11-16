# Roles and permissions

The role matrix for M1. It applies D25 to D28. The API enforces it through one function in `packages/core`, and row-level security in Postgres enforces it again underneath. A change to this file is a gated change.

## Principals

- A **person** signs in with email and password and gets a session (D42).
- An **agent key** is a bearer token scoped to exactly one hub (D28). It has no workspace role beyond `member`.

Both kinds are principals and go through the same checks (D25).

## Two layers

1. The **workspace role** sets *what* someone can do in the workspace.
2. A **hub grant** sets *where*. Without a grant on a hub, a principal sees nothing inside it: no folders, attributes or items (D27). Hub names show only in the hub list, and only to owners and admins. **This applies to owners and admins too:** they can grant themselves access to any hub, and the grant is recorded in the revision log, but until they do they cannot read inside it.

A person's **effective hub role** is their hub grant, capped by their workspace role:

| Workspace role | Highest effective hub role |
|---|---|
| owner, admin, member | as granted |
| viewer, finance | viewer |

## Workspace actions

| Action | owner | admin | member | viewer | finance | agent key |
|---|---|---|---|---|---|---|
| See the workspace and its member list | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| See the names of every hub | ✓ | ✓ | — | — | — | — |
| See hubs they hold a grant on | ✓ | ✓ | ✓ | ✓ | ✓ | its one hub |
| Invite members, change roles, remove members | ✓ | ✓ ¹ | — | — | — | — |
| Create a hub (the creator becomes its hub admin) | ✓ | ✓ | — | — | — | — |
| Grant or revoke access on any hub | ✓ | ✓ | — | — | — | — |
| Create and revoke agent keys on any hub | ✓ | ✓ | — | — | — | — |
| Billing (no billing exists yet) | ✓ | — | — | — | ✓ | — |
| Rename or delete the workspace | ✓ | — | — | — | — | — |

¹ An admin cannot change, remove or create an owner. There is always at least one owner.

## Hub actions (by effective hub role)

| Action | hub admin | editor | commenter | viewer |
|---|---|---|---|---|
| Describe the hub, read and query items | ✓ | ✓ | ✓ | ✓ |
| Create, edit and delete items | ✓ | ✓ | — | — |
| Comment (when comments exist) | ✓ | ✓ | ✓ | — |
| Manage folders and attributes | ✓ | — | — | — |
| Grant or revoke access on this hub | ✓ ² | — | — | — |
| Create and revoke agent keys for this hub | ✓ | — | — | — |

² A hub admin cannot grant a role above their own, and cannot change their own grant.

## Agent keys

- Scoped to one hub, with role `editor`, `commenter` or `viewer`. Never `hub admin` (D28).
- They can never manage members, grants, keys, folders or attributes, and never touch billing.
- Shown once when created and stored hashed. They can be revoked, and an optional expiry date can be set.
- Writes are recorded with the key's principal as `updated_by`.

## Relations across hubs

A relation attribute can point outside its hub only when that attribute allows it (D11). Even then, a principal sees a linked item only if they could read it directly: otherwise the link shows as "no access", never its values.

## Not in M1

- Folder grants that narrow a hub grant (D27). The model allows them; they come with the settings work in M2.
- Billing.
- Passing a session or key from one principal to another.

## Answers to errors

- Not signed in, or a bad or revoked key: 401.
- Signed in but the role doesn't allow the action: 403.
- A hub, folder or item the principal has no grant for: **404, not 403**, so hidden things can't be probed.
