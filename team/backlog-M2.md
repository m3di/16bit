# Sprint 2 backlog: dashboard and settings

The initial plan for M2. Each entry becomes a GitHub issue during planning; after that GitHub is the source of truth and this file is not edited.

**Sprint goal:** a hub can be created, given attributes and folders, and populated, entirely from the UI; owners and admins run members, invites, hub access and agent keys from settings; every item has a page.

**Decisions this plan rests on:** D50 (hub title attribute), D51 (attribute types and relation targets are fixed), D52 (delete only when empty, and what deleting a hub removes), D53 (root views wait for M4), D54 (folder grants wait until after M2), and the `docs/ROLES.md` rows added with them: listing a hub's grants, and creating a cross-hub relation. After the review of the planning PR (#108) the plan gained the grant list, the hub delete rules, the migration's privileges and attribute versions, folder cycle checks, and a smaller M2-09. Every list route added in M2 is paged.

---

## M2-01 Schema write contracts in core
- **Role:** backend
- **Depends on:** nothing
- **Gate:** needs-human (`packages/core` contracts)
- **Acceptance:** `packages/core` exports request and response shapes for: updating a hub (name, colour, title attribute); creating, renaming, moving and deleting folders; creating attributes (name, type, type options) and updating them (name and select options; never the type, a relation's target or its cross-hub flag, D51); attaching, detaching and reordering a folder's attributes and setting `required` per folder; listing a hub's grants (paged); listing and revoking invites (paged). `can()` gains the grant-list action and the cross-hub relation rule from `docs/ROLES.md`. Removing an option or attribute in use takes an explicit `confirm` with the affected count it was shown, and the API answers 409 with the current count when they differ. Contract tests for each shape, including a rejected type change.

## M2-02 Schema write migration
- **Role:** backend
- **Depends on:** nothing (it can run alongside M2-01)
- **Gate:** needs-human (migration, row-level security)
- **Acceptance:** a new migration adds:
  - `title_attribute_id` on `folder`, allowed only on hub rows (a `CHECK`), pointing at a `text` attribute of the same hub (composite foreign key for the hub, a trigger for the type), cleared when that attribute is removed (D50);
  - a `version` column on `attribute`, so attribute writes carry a version check like items; changes to a folder's attributes (attach, detach, reorder, `required`) check and bump `folder.version`;
  - the privileges the API role lacks today: insert, update and delete on `attribute` and `folder_attribute`, update of the editable `folder` columns, and delete on `folder` (`0008` grants only some of these);
  - row-level security for schema writes: only an effective hub admin writes `attribute` and `folder_attribute` in a hub. Creating and deleting folders are ordinary row-level security rules for hub admins. Editors already update `folder` rows (item counters), so changes to a folder's name, colour, parent and `title_attribute_id` are checked by a guard trigger like `workspace_guard`;
  - a `SECURITY DEFINER` `delete_hub()` function, set up like the others in `0008` (`search_path` pinned, `EXECUTE` revoked from `PUBLIC` and granted to the API role) and following the lock order in `docs/ARCHITECTURE.md`, that applies D52 (deleting `folder_attribute` rows before attributes): owner or admin with a grant, refused for an admin when an owner holds a grant, refused if not empty or targeted by another hub's relation; it revokes the hub's keys, deletes its grants and attributes, and logs to `access_log`;
  - an explicit `GRANT USAGE ON SCHEMA public` to the API role, which today relies on Postgres's default and breaks on a hardened or recreated schema.

  Tests apply it to an empty database and one migrated to `0008`, and show each policy refusing a lower role.

## M2-03 Schema write API
- **Role:** backend
- **Depends on:** M2-01, M2-02
- **Gate:** needs-human (authentication and access rules: grant listing, hub delete)
- **Acceptance:** routes for every M2-01 shape, checked with `can()` (`docs/ROLES.md`: hub admin manages folders and attributes, owner and admin delete hubs). Deleting a non-empty folder or hub is a 409 (D52); deleting an empty hub calls `delete_hub()`, which revokes its agent keys and removes its grants and attributes (logged in `access_log`); it is a 409 while another hub's relation attribute targets it, and a 403 for an admin when an owner holds a grant on it. Moving a folder under itself or one of its descendants is a 400. Creating a cross-hub relation needs at least viewer access on the target hub. `GET /hubs/:hubId/grants` lists grants for hub admins of the hub and for owners and admins with or without a grant. Removing an option or attribute strips its values from items in the same transaction, writes a revision per changed item, and updates `item_index` and `link`. Schema changes carry a version check like items. `GET /hubs/:hubId` returns the title attribute. Integration tests per route, role and failure, including the affected-count mismatch.

## M2-04 Invites and self-grant API gaps
- **Role:** backend
- **Depends on:** M2-01
- **Acceptance:** owners and admins list a workspace's pending invites (paged) and revoke them; creating and revoking invites are both written to `access_log`. The invite link stays copy-only (no email, D42). Tests for roles and for redeeming a revoked invite.

## M2-05 Design system components for settings
- **Role:** design-system
- **Depends on:** nothing
- **Acceptance:** following `docs/DESIGN.md` and the workspace and hub settings mockups: a settings layout with section navigation, tabs, a dialog and a confirm dialog (which can require typing a name), a row actions menu, a 16-colour palette picker, a toggle, an attribute type picker, and an options editor for select types. Each has its loading, empty, error, no-permission and, where it opens by ID, not-found states. Added to the kit page and `docs/DESIGN.md` under "Components for M2", with keyboard and screen-reader tests.

## M2-06 Workspace settings: members and invites
- **Role:** frontend
- **Depends on:** M2-04, M2-05
- **Acceptance:** owners and admins open workspace settings from the shell: member list with roles, change role, remove member, create an invite and copy its link, list and revoke pending invites. Every rule in the `docs/ROLES.md` workspace table is reflected (an admin sees owners as read-only, there is always one owner). Members and viewers see the read-only member list. Component tests per role.

## M2-07 Hub settings: general, access and agent keys
- **Role:** frontend
- **Depends on:** M2-03, M2-05
- **Acceptance:** hub admins rename the hub, set its colour and title attribute (D50), grant, change and revoke hub access, and create, list and revoke agent keys (secret shown once). Owners and admins delete an empty hub they hold a grant on (D52). The dashboard's "no access" hub card offers owners and admins a self-grant, which is logged. The web app titles items with the title attribute everywhere it used the first text attribute. Component tests per role.

## M2-08 Hub settings: folders and attributes
- **Role:** frontend
- **Depends on:** M2-03, M2-05
- **Acceptance:** hub admins create, rename, nest and delete empty folders; create attributes of every M1 type, rename them, edit options and required, attach them to folders and reorder them; removing an option or attribute in use shows the affected item count and asks for confirmation (D51). The type is shown but cannot be changed. Component tests for each flow and its refusal.

## M2-09 Create hubs from the dashboard
- **Role:** frontend
- **Depends on:** M2-05, M2-07
- **Acceptance:** `POST /hubs` and the folder view's "New item" already exist. Owners and admins create a hub from the dashboard (name and colour) and land in its new settings as its hub admin. "New item" validates the folder's required attributes before sending and opens the new item's page once M2-10 lands. Component tests.

## M2-10 Item page
- **Role:** frontend
- **Depends on:** M2-03, M2-05
- **Acceptance:** an item opens on its own page by ID (following the task mockup): title from the title attribute, every attribute of its folder with the editors from M1 and read-only states per role, relations with "no access" handling, backlinks with the hidden count, and delete for editors. Loading, error, no-permission and not-found states. A stale version shows the 409 conflict and the current value instead of overwriting. The table panel links to it. Component tests.

## M2-11 Seed and build hub use title attributes
- **Role:** backend
- **Depends on:** M2-03
- **Acceptance:** `pnpm seed` and `pnpm seed:build-hub` set a title attribute on every hub they create. Tests.

## M2-12 Settings end-to-end suite and exit check
- **Role:** qa
- **Depends on:** M2-06 to M2-10
- **Acceptance:** an end-to-end test signs in, creates a hub, adds attributes of several types and nested folders, sets the title attribute, creates items, opens one on its page and edits it, all through the UI (the M2 exit criterion). Further tests: invite a person and sign in with the link; grant them a hub; a hub editor cannot open hub settings; deleting a non-empty folder is refused. Runs in the required End-to-end check.

## M2-13 M2 report
- **Role:** lead
- **Depends on:** all
- **Acceptance:** `docs/reports/M2.md` in the format of the M1 report.

## Carried over
- **#107** API crashes if Postgres terminates idle pool connections (backend, outside M1). Fixed early in this sprint, since every later test run restarts databases.
