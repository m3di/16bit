import { sql, type Kysely } from 'kysely'

// M5 (#205, D72): the external login name, for trusted-header sign-in behind a login gateway
// (#213, gated on its own) and invites by external login.
//
// - `account.external_login text NULL`: the login name the gateway sends, unique per
//   installation (`account_external_login_key`), compared exactly, byte for byte under the
//   database's deterministic collation. An account created through an external-login invite has
//   no password, so `password_hash` may be null, but only for an account with an external login
//   (`account_sign_in_check`): every account keeps a way to sign in. Sign-in by password treats
//   a null hash as a wrong password.
// - `invite.external_login text NULL`: an invite bound to one external login. Only the
//   trusted-header path (#213) may accept it, and #213 must change `redeem_invite` (0004) to
//   check it in the same migration that lets the API create such invites. Until then the API
//   refuses `externalLogin` on create, so no row has one.
// - Both columns follow `externalLoginSchema` in packages/core: 1 to 256 characters (code
//   points), no control characters (Unicode `Cc`; text can't hold U+0000), and none of
//   JavaScript's `\s` whitespace at either end, the set 0015 uses for external keys.
// - The API role already has table-level SELECT and INSERT on both tables (0008), which cover
//   the new columns. It gets no UPDATE on either: linking a login to an existing account is an
//   operator's job, like a password reset (D42).
//
// Adding nullable columns without a default only changes the catalog. The unique index starts
// empty, since no row has a login.

const WHITESPACE = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`

const loginCheck = (column: string) => sql`CHECK (
  char_length(${sql.ref(column)}) BETWEEN 1 AND 256
  AND ${sql.ref(column)} !~ ${sql.lit(String.raw`[\u0001-\u001f\u007f-\u009f]`)}
  AND ${sql.ref(column)} !~ ${sql.lit(`^${WHITESPACE}`)}
  AND ${sql.ref(column)} !~ ${sql.lit(`${WHITESPACE}$`)}
)`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE account
      ADD COLUMN external_login text,
      ADD CONSTRAINT account_external_login_check ${loginCheck('external_login')},
      ADD CONSTRAINT account_external_login_key UNIQUE (external_login),
      ALTER COLUMN password_hash DROP NOT NULL,
      ADD CONSTRAINT account_sign_in_check
        CHECK (password_hash IS NOT NULL OR external_login IS NOT NULL);

    ALTER TABLE invite
      ADD COLUMN external_login text,
      ADD CONSTRAINT invite_external_login_check ${loginCheck('external_login')};
  `.execute(db)
}

/**
 * Drops both columns, and with them every login name and every invite's binding. Stops while an
 * account has no password, naming how many: it could not sign in afterwards. Give each one a
 * password with `pnpm account:reset-password` first.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM account WHERE password_hash IS NULL;
      IF n > 0 THEN
        RAISE EXCEPTION '% account(s) have no password and sign in only by external login; set a password with pnpm account:reset-password before migrating down', n;
      END IF;
    END $$;

    ALTER TABLE invite DROP COLUMN external_login;
    ALTER TABLE account
      DROP CONSTRAINT account_sign_in_check,
      ALTER COLUMN password_hash SET NOT NULL,
      DROP COLUMN external_login;
  `.execute(db)
}
