// `pnpm account:reset-password <email>`: the operator's password reset (D42). There is no
// reset in the API. With a password piped on stdin it sets that one; run in a terminal, it
// generates one and prints it once. Every session of the account is ended.
import { randomBytes } from 'node:crypto'
import { text } from 'node:stream/consumers'
import { createDb } from './db/database.ts'
import { resetPassword } from './reset-password.ts'

// Runs as the owner of the tables, like migrations (#44).
const databaseUrl = process.env['MIGRATION_DATABASE_URL']
const email = process.argv.slice(2).find((arg) => arg !== '--')
if (!databaseUrl || !email) {
  console.error('usage: pnpm account:reset-password <email>   (MIGRATION_DATABASE_URL must be set)')
  console.error('  echo "new password" | pnpm account:reset-password <email>')
  process.exit(1)
}

const generated = process.stdin.isTTY ? randomBytes(18).toString('base64url') : undefined
const password = generated ?? (await text(process.stdin)).replace(/\r?\n$/, '')

const db = createDb(databaseUrl)
try {
  if (!(await resetPassword(db, email, password))) {
    console.error(`account:reset-password: no account with email ${email}`)
    process.exitCode = 1
  } else {
    console.log(`account:reset-password: password set for ${email}; its sessions were ended.`)
    if (generated) console.log(`New password (shown once): ${generated}`)
  }
} catch (error) {
  console.error(`account:reset-password: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await db.destroy()
}
