import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, migrateToLatest } from './db/database.ts'
import { createTestDatabase } from './db/test-database.ts'

const server = fileURLToPath(new URL('./server.ts', import.meta.url))

// The server checks its database role before it binds (#44), so it needs a migrated database.
let ownerUrl: string
let appUrl: string
let drop: () => Promise<void>

beforeAll(async () => {
  const test = await createTestDatabase()
  ownerUrl = test.url
  appUrl = test.appUrl
  drop = test.drop
  const db = createDb(test.url)
  try {
    await migrateToLatest(db)
  } finally {
    await db.destroy()
  }
}, 60_000)

afterAll(async () => {
  await drop()
})

/** Starts the server with `databaseUrl`; collects stdout and stderr together. */
function start(databaseUrl: string) {
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = { text: '' }
  const collect = (chunk: Buffer) => (out.text += chunk.toString())
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return { child, out }
}

describe('server', () => {
  it('refuses to serve as a role RLS does not apply to, before it binds', async () => {
    const { child, out } = start(ownerUrl)
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(1)
    expect(out.text).toContain('refusing to serve')
    expect(out.text).not.toContain('api listening')
  })

  it('does not bind while it cannot check its role', async () => {
    const { child, out } = start('postgres://unused@127.0.0.1:1/unused')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(out.text).not.toContain('api listening')
    child.kill('SIGTERM')
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(0)
  }, 15_000)

  it.each(['SIGTERM', 'SIGINT'] as const)('closes and exits 0 on %s', async (signal) => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        DATABASE_URL: appUrl,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('api listening')) resolve()
      })
      child.once('exit', () => {
        reject(new Error(`server exited before listening: ${output}`))
      })
    })

    child.kill(signal)
    const [code] = (await once(child, 'exit')) as [number | null]

    expect(code).toBe(0)
    expect(output).toContain(`api received ${signal}, closing`)
  })

  it('refuses to start with an invalid sign-in limit, before it binds (#229)', async () => {
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, PORT: '0', DATABASE_URL: appUrl, SIGN_IN_LIMIT_PER_IP: 'lots' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const collect = (chunk: Buffer) => (out += chunk.toString())
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(1)
    expect(out).toContain('SIGN_IN_LIMIT_PER_IP must be a whole number')
    expect(out).not.toContain('api listening')
  })

  it('warns at start when production takes its sign-in limits from the environment (#229)', async () => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'production',
        SIGN_IN_LIMIT_PER_IP: '10000',
        // Never reachable, so it waits before binding and is killed below.
        DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    await new Promise<void>((resolve, reject) => {
      const collect = (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('Meant for tests only')) resolve()
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.once('exit', () => {
        reject(new Error(`server exited without the warning: ${out}`))
      })
    })
    child.kill('SIGTERM')
    await once(child, 'exit')
    expect(out).toContain('api: sign-in limits set from the environment: 10000 per IP')
  }, 15_000)

  it('refuses to start without DATABASE_URL', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0' }
    delete env['DATABASE_URL']
    const child = spawn(process.execPath, [server], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(1)
    expect(stderr).toContain('DATABASE_URL')
  })
})
