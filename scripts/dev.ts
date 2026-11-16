// `pnpm dev`: prepare .env, wait for Postgres, run migrations, then start the
// API and the web dev server together.
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Copies .env.example to .env when .env is missing. Returns true if it did. */
export function ensureEnvFile(dir: string): boolean {
  const env = `${dir}/.env`
  if (existsSync(env)) return false
  copyFileSync(`${dir}/.env.example`, env)
  return true
}

/** Resolves once a TCP connection to the database host succeeds, or rejects after timeoutMs. */
export async function waitForDatabase(databaseUrl: string, timeoutMs: number): Promise<void> {
  const url = new URL(databaseUrl)
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1') || '127.0.0.1'
  const port = Number(url.port || 5432)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (await canConnect(host, port)) return
    if (Date.now() >= deadline) {
      throw new Error(`Postgres is not reachable at ${host}:${String(port)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}

function run(args: string[]): ChildProcess {
  return spawn('pnpm', args, { cwd: root, stdio: 'inherit' })
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

async function main(): Promise<void> {
  if (ensureEnvFile(root)) console.log('dev: created .env from .env.example')
  process.loadEnvFile(`${root}/.env`)

  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    console.error('dev: DATABASE_URL is not set. See .env.example.')
    process.exit(1)
  }

  try {
    console.log('dev: waiting for Postgres')
    await waitForDatabase(databaseUrl, 30_000)
  } catch (error) {
    console.error(`dev: ${(error as Error).message}.`)
    console.error('dev: start it with `docker compose up -d db`, or set DATABASE_URL in .env.')
    process.exit(1)
  }

  const migrated = await exitCode(run(['--filter', '@16bit/api', 'migrate']))
  if (migrated !== 0) process.exit(migrated)

  const servers = run(['--parallel', '--filter', '@16bit/api', '--filter', '@16bit/web', 'dev'])
  // Ctrl-C already reaches every process in the terminal's group, so only wait.
  // SIGTERM is usually sent to this process alone, so pass it on.
  process.on('SIGINT', () => undefined)
  process.on('SIGTERM', () => servers.kill('SIGTERM'))
  process.exit(await exitCode(servers))
}

if (import.meta.main) await main()
