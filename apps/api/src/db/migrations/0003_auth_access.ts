import { sql, type Kysely } from 'kysely'

// M1 auth and access schema from docs/ARCHITECTURE.md (D42, D46, D47, D48).
//
// `account` and `session` are installation-level and sit outside row-level security (D46).
// Every other new table is workspace-scoped and `workspace_id` leads its keys. Three indexes
// do not lead with it, because the architecture resolves them before a principal is known,
// through SECURITY DEFINER functions: an agent key's secret hash, an invite's token hash, and
// an account's memberships.
//
// Hashes are stored as text; the auth code picks the encoding. Secrets themselves never are.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE account (
      id             text        PRIMARY KEY,
      -- Stored trimmed and lowercased, so the plain unique key is case-insensitive uniqueness.
      email          text        NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email <> ''),
      -- argon2id PHC string (D42). Anything else is refused.
      password_hash  text        NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
      name           text        NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE session (
      id_hash       text        PRIMARY KEY,
      account_id    text        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_seen_at  timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      CHECK (expires_at > created_at)
    );
    -- Sign out everywhere, and sweeping expired sessions.
    CREATE INDEX session_account_idx ON session (account_id);
    CREATE INDEX session_expires_idx ON session (expires_at);

    -- Next access_log.seq for this workspace (D48), taken in the access-change transaction.
    ALTER TABLE workspace
      ADD COLUMN next_access_seq bigint NOT NULL DEFAULT 1 CHECK (next_access_seq >= 1);

    -- A person has one principal per workspace, linked to their account. Agents never have an
    -- account and are always workspace members (D47). Users without an account are allowed
    -- for principals created before M1 (the dev owner, seeds, imports).
    ALTER TABLE principal
      ADD COLUMN account_id text REFERENCES account (id),
      ADD CONSTRAINT principal_account_kind_check CHECK (kind = 'user' OR account_id IS NULL),
      ADD CONSTRAINT principal_agent_role_check CHECK (kind = 'user' OR workspace_role = 'member'),
      ADD CONSTRAINT principal_workspace_account_key UNIQUE (workspace_id, account_id),
      -- Target for the (workspace_id, principal_id, kind) foreign keys below.
      ADD CONSTRAINT principal_workspace_id_kind_key UNIQUE (workspace_id, id, kind);
    -- Lookup without a workspace: an account's memberships for GET /v1/me.
    CREATE INDEX principal_account_idx ON principal (account_id) WHERE account_id IS NOT NULL;

    CREATE TABLE invite (
      workspace_id    text        NOT NULL REFERENCES workspace (id),
      id              text        NOT NULL,
      token_hash      text        NOT NULL,
      workspace_role  text        NOT NULL
        CHECK (workspace_role IN ('owner', 'admin', 'member', 'viewer', 'finance')),
      created_by      text        NOT NULL,
      expires_at      timestamptz NOT NULL,
      used_at         timestamptz,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY (workspace_id, created_by) REFERENCES principal (workspace_id, id),
      CHECK (used_at IS NULL OR used_at <= expires_at)
    );
    -- Lookup without a workspace: redeem_invite(token_hash, account_id).
    CREATE UNIQUE INDEX invite_token_hash_key ON invite (token_hash);

    -- One key per agent principal. Its hub and role live in hub_grant (D47).
    -- principal_kind is constant: the foreign key then only matches a principal of kind 'agent',
    -- so a key can never authenticate as a person.
    CREATE TABLE agent_key (
      workspace_id    text        NOT NULL REFERENCES workspace (id),
      principal_id    text        NOT NULL,
      principal_kind  text        NOT NULL DEFAULT 'agent' CHECK (principal_kind = 'agent'),
      secret_hash     text        NOT NULL,
      expires_at      timestamptz,
      revoked_at      timestamptz,
      PRIMARY KEY (workspace_id, principal_id),
      FOREIGN KEY (workspace_id, principal_id, principal_kind)
        REFERENCES principal (workspace_id, id, kind)
    );
    -- Lookup without a workspace: resolving a bearer key to its principal, workspace and hub.
    CREATE UNIQUE INDEX agent_key_secret_hash_key ON agent_key (secret_hash);

    -- Where a principal may look (D27). The (workspace_id, hub_id, hub_id) FK only matches a hub.
    -- principal_kind mirrors principal.kind (which never changes) so the database itself holds
    -- the agent rules: at most one grant, and never hub_admin (D28, D47).
    CREATE TABLE hub_grant (
      workspace_id    text NOT NULL REFERENCES workspace (id),
      hub_id          text NOT NULL,
      principal_id    text NOT NULL,
      principal_kind  text NOT NULL DEFAULT 'user',
      hub_role        text NOT NULL
        CHECK (hub_role IN ('hub_admin', 'editor', 'commenter', 'viewer')),
      PRIMARY KEY (workspace_id, hub_id, principal_id),
      FOREIGN KEY (workspace_id, hub_id, hub_id) REFERENCES folder (workspace_id, hub_id, id),
      FOREIGN KEY (workspace_id, principal_id, principal_kind)
        REFERENCES principal (workspace_id, id, kind),
      CONSTRAINT hub_grant_agent_role_check CHECK (principal_kind = 'user' OR hub_role <> 'hub_admin')
    );
    CREATE INDEX hub_grant_principal_idx ON hub_grant (workspace_id, principal_id);
    CREATE UNIQUE INDEX hub_grant_one_per_agent_key
      ON hub_grant (workspace_id, principal_id) WHERE principal_kind = 'agent';

    -- Append-only log of access changes (D48): grants, role changes, member removal, keys.
    -- No foreign key on target: it names whatever changed and outlives it. Append-only is
    -- enforced by privileges once the app role exists (M1-06): it gets INSERT and SELECT only.
    CREATE TABLE access_log (
      workspace_id  text        NOT NULL REFERENCES workspace (id),
      seq           bigint      NOT NULL CHECK (seq >= 1),
      actor         text        NOT NULL,
      action        text        NOT NULL CHECK (action <> ''),
      target        text        NOT NULL,
      detail        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
      at            timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, seq),
      FOREIGN KEY (workspace_id, actor) REFERENCES principal (workspace_id, id)
    );
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE access_log;
    DROP TABLE hub_grant;
    DROP TABLE agent_key;
    DROP TABLE invite;
    DROP INDEX principal_account_idx;
    ALTER TABLE principal
      DROP CONSTRAINT principal_workspace_id_kind_key,
      DROP CONSTRAINT principal_workspace_account_key,
      DROP CONSTRAINT principal_agent_role_check,
      DROP CONSTRAINT principal_account_kind_check,
      DROP COLUMN account_id;
    ALTER TABLE workspace DROP COLUMN next_access_seq;
    DROP TABLE session;
    DROP TABLE account;
  `.execute(db)
}
