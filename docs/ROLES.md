# Roles and permissions

The role matrix for M1. It applies D25 to D28. The API enforces it through one function in `packages/core`, and row-level security in Postgres enforces it again underneath. A change to this file is a gated change.

## Principals

- A **person** signs in with email and password and gets a session (D42).
- An **agent key** is a bearer token. Each key is its own principal of kind `agent`, with workspace role `member` and exactly one hub grant (D28, D47). Being an agent removes every workspace action, whatever the role says.

Both kinds are principals and go through the same checks (D25).

## Two layers

1. The **workspace role** sets *what* someone can do in the workspace.
2. A **hub grant** sets *where*. Without a grant on a hub, a principal sees nothing inside it: no folders, attributes or items (D27). Owners and admins see the names of all hubs in the hub list; everyone else sees only the hubs they hold a grant on. **The grant rule binds owners and admins too:** they can grant themselves access to any hub (recorded in `access_log`, D48), but until they do, everything inside the hub returns 404 to them. The hub list marks such hubs as "no access". In M1, self-granting is done through the API only; the dashboard offer comes with settings in M2.

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
| Invite members and change their roles | ✓ | ✓ ¹ | — | — | — | — |
| Create a hub (the creator becomes its hub admin) | ✓ | ✓ | — | — | — | — |
| Grant or revoke access on any hub | ✓ | ✓ | — | — | — | — |
| Create agent keys on a hub they hold a grant on ² | ✓ | ✓ | — | — | — | — |
| Revoke any agent key in the workspace | ✓ | ✓ | — | — | — | — |
| Billing (no billing exists yet) | ✓ | — | — | — | ✓ | — |
| Delete a hub | ✓ | ✓ | — | — | — | — |
| Remove a member (revokes their grants in this workspace; agent keys they created stay until revoked) | ✓ | ✓ ¹ | — | — | — | — |
| Rename or delete the workspace | ✓ | — | — | — | — | — |

¹ An admin cannot change, remove or create an owner. There is always at least one owner.

² Owners and admins must hold a grant on a hub (self-granting if needed, D45) before creating keys for it, so no key is made for a hub its creator can't see. Revoking needs no grant: it reveals nothing inside the hub.

## Hub actions (by effective hub role)

| Action | hub admin | editor | commenter | viewer |
|---|---|---|---|---|
| Describe the hub, read and query items | ✓ | ✓ | ✓ | ✓ |
| Create, edit and delete items | ✓ | ✓ | — | — |
| Comment (when comments exist) | ✓ | ✓ | ✓ | — |
| Rename the hub, manage folders and attributes | ✓ | — | — | — |
| Grant or revoke access on this hub | ✓ ³ | — | — | — |
| Create and revoke agent keys for this hub | ✓ | — | — | — |

³ A hub admin can grant any hub role, including hub admin, to others. They cannot change or revoke their own grant, or the grant of a workspace owner or admin.

## Agent keys

- Scoped to one hub, with role `editor`, `commenter` or `viewer`. Never `hub admin` (D28).
- They can never manage members, grants, keys, folders or attributes, and never touch billing.
- Shown once when created and stored hashed. They can be revoked, and an optional expiry date can be set. Creating or revoking a key is recorded in `access_log`.
- Writes are recorded with the key's principal as `updated_by`.

## Relations across hubs

A relation attribute can point outside its hub only when that attribute allows it (D11). Even then, a principal sees a linked item only if they could read it directly: otherwise the link shows as "no access", never its values.

## Passwords

There is no password reset in the API. The installation operator resets a password with a CLI command (D42).

## Not in M1

- Folder grants that narrow a hub grant (D27). The model allows them; they come with the settings work in M2.
- Billing.
- Passing a session or key from one principal to another.

## Answers to errors

- Not signed in, or a bad or revoked key: 401.
- Signed in but the role doesn't allow the action: 403.
- A hub, folder or item the principal has no grant for: **404, not 403**, so hidden things can't be probed.
