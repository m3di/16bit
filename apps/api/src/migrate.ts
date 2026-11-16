// Entry point for `pnpm db:migrate`, also run by `pnpm dev` before the servers start.
// Placeholder until #5 adds the schema: backend replaces the body with the real migrator.
const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is not set. See .env.example.')
  process.exit(1)
}

console.log('migrate: no migrations yet')
