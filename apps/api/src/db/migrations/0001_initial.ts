import { sql, type Kysely } from 'kysely'

// M0 schema from docs/ARCHITECTURE.md: workspace, principal, folder, attribute,
// folder_attribute, item, revision. `workspace_id` leads every key and index.
// IDs are text so they match `idSchema` in packages/core.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE workspace (
      id          text        PRIMARY KEY,
      name        text        NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE principal (
      workspace_id    text NOT NULL REFERENCES workspace (id),
      id              text NOT NULL,
      kind            text NOT NULL CHECK (kind IN ('user', 'agent')),
      name            text NOT NULL,
      workspace_role  text NOT NULL
        CHECK (workspace_role IN ('owner', 'admin', 'member', 'viewer', 'finance')),
      PRIMARY KEY (workspace_id, id)
    );

    -- A hub is a folder with no parent whose hub_id is its own id (D2, D3).
    -- The (workspace_id, hub_id, id) key lets children and items prove they sit in the same hub.
    CREATE TABLE folder (
      workspace_id  text   NOT NULL REFERENCES workspace (id),
      id            text   NOT NULL,
      hub_id        text   NOT NULL,
      parent_id     text,
      name          text   NOT NULL,
      color         text   NOT NULL,
      id_prefix     text   NOT NULL,
      item_count    bigint NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      version       bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
      PRIMARY KEY (workspace_id, id),
      UNIQUE (workspace_id, hub_id, id),
      CHECK ((parent_id IS NULL) = (hub_id = id)),
      FOREIGN KEY (workspace_id, hub_id) REFERENCES folder (workspace_id, id),
      FOREIGN KEY (workspace_id, hub_id, parent_id) REFERENCES folder (workspace_id, hub_id, id)
    );
    CREATE INDEX folder_hub_idx ON folder (workspace_id, hub_id);
    CREATE INDEX folder_parent_idx ON folder (workspace_id, parent_id);

    -- Attributes belong to a hub (D10). M0 types only; later types arrive with their own migration.
    CREATE TABLE attribute (
      workspace_id  text    NOT NULL REFERENCES workspace (id),
      id            text    NOT NULL,
      hub_id        text    NOT NULL,
      name          text    NOT NULL,
      type          text    NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'date', 'select')),
      config        jsonb   NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
      indexed       boolean NOT NULL DEFAULT false,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY (workspace_id, hub_id) REFERENCES folder (workspace_id, id)
    );
    CREATE INDEX attribute_hub_idx ON attribute (workspace_id, hub_id);

    CREATE TABLE folder_attribute (
      workspace_id  text    NOT NULL REFERENCES workspace (id),
      folder_id     text    NOT NULL,
      attribute_id  text    NOT NULL,
      position      integer NOT NULL CHECK (position >= 0),
      required      boolean NOT NULL DEFAULT false,
      PRIMARY KEY (workspace_id, folder_id, attribute_id),
      FOREIGN KEY (workspace_id, folder_id) REFERENCES folder (workspace_id, id),
      FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute (workspace_id, id)
    );
    CREATE INDEX folder_attribute_attribute_idx ON folder_attribute (workspace_id, attribute_id);

    -- One home per item (D4). The folder FK includes hub_id, so an item's hub always matches its folder's.
    CREATE TABLE item (
      workspace_id  text        NOT NULL REFERENCES workspace (id),
      id            text        NOT NULL,
      hub_id        text        NOT NULL,
      folder_id     text        NOT NULL,
      seq_id        bigint      NOT NULL CHECK (seq_id >= 1),
      values        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(values) = 'object'),
      version       bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    text        NOT NULL,
      PRIMARY KEY (workspace_id, id),
      UNIQUE (workspace_id, hub_id, seq_id),
      FOREIGN KEY (workspace_id, hub_id, folder_id) REFERENCES folder (workspace_id, hub_id, id),
      FOREIGN KEY (workspace_id, updated_by) REFERENCES principal (workspace_id, id)
    );
    -- M0 lists items by folder, newest update first, with an (updated_at, id) cursor.
    CREATE INDEX item_folder_updated_idx ON item (workspace_id, folder_id, updated_at DESC, id DESC);

    -- Append-only log (D9). No FK to item: history outlives a deleted item.
    CREATE TABLE revision (
      workspace_id  text        NOT NULL REFERENCES workspace (id),
      seq           bigint      NOT NULL CHECK (seq >= 1),
      item_id       text        NOT NULL,
      version       bigint      NOT NULL CHECK (version >= 1),
      patch         jsonb       NOT NULL,
      actor         text        NOT NULL,
      cause         text,
      at            timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, seq),
      UNIQUE (workspace_id, item_id, version),
      FOREIGN KEY (workspace_id, actor) REFERENCES principal (workspace_id, id)
    );
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE revision;
    DROP TABLE item;
    DROP TABLE folder_attribute;
    DROP TABLE attribute;
    DROP TABLE folder;
    DROP TABLE principal;
    DROP TABLE workspace;
  `.execute(db)
}
