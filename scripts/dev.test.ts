import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ensureEnvFile, serverEnv, waitForDatabase } from './dev.ts'

describe('ensureEnvFile', () => {
  it('copies .env.example when .env is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), '16bit-dev-'))
    writeFileSync(join(dir, '.env.example'), 'A=1\n')

    expect(ensureEnvFile(dir)).toBe(true)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('A=1\n')
  })

  it('leaves an existing .env alone', () => {
    const dir = mkdtempSync(join(tmpdir(), '16bit-dev-'))
    writeFileSync(join(dir, '.env.example'), 'A=1\n')
    writeFileSync(join(dir, '.env'), 'A=2\n')

    expect(ensureEnvFile(dir)).toBe(false)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('A=2\n')
  })
})

describe('waitForDatabase', () => {
  it('resolves when the port accepts connections', async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    try {
      await expect(
        waitForDatabase(`postgres://u:p@127.0.0.1:${String(port)}/db`, 2000),
      ).resolves.toBeUndefined()
    } finally {
      server.close()
    }
  })

  it('rejects when nothing listens before the timeout', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))

    await expect(
      waitForDatabase(`postgres://u:p@127.0.0.1:${String(port)}/db`, 300),
    ).rejects.toThrow(`Postgres is not reachable at 127.0.0.1:${String(port)}`)
  })
})

describe('dev script', () => {
  it('exits promptly on SIGTERM while waiting for Postgres', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))

    const child = spawn(process.execPath, [fileURLToPath(new URL('./dev.ts', import.meta.url))], {
      env: {
        ...process.env,
        DATABASE_URL: `postgres://u:p@127.0.0.1:${String(port)}/db`,
        MIGRATION_DATABASE_URL: `postgres://o:p@127.0.0.1:${String(port)}/db`,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('waiting for Postgres')) resolve()
      })
    })

    child.kill('SIGTERM')
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(143)
  })
})

// The API never holds the owner's URL (#44): migrations get it, the dev servers don't.
describe('the owner URL under pnpm dev', () => {
  const OWNER = 'postgres://owner:secret@127.0.0.1:1/db'

  /** What the API's own `dev` script sees, run from a copy of the layout with OWNER in .env. */
  async function apiDevSees(env: NodeJS.ProcessEnv): Promise<unknown> {
    const apiPackage = fileURLToPath(new URL('../apps/api/package.json', import.meta.url))
    const { scripts } = JSON.parse(readFileSync(apiPackage, 'utf8')) as {
      scripts: Record<string, string>
    }
    const dir = mkdtempSync(join(tmpdir(), '16bit-dev-'))
    writeFileSync(join(dir, '.env'), `MIGRATION_DATABASE_URL=${OWNER}\n`)
    mkdirSync(join(dir, 'apps/api/src'), { recursive: true })
    // Stands in for the server: reports what it was given.
    writeFileSync(
      join(dir, 'apps/api/src/server.ts'),
      "console.log('owner=' + JSON.stringify(process.env['MIGRATION_DATABASE_URL'] ?? null))\n",
    )
    // Its own process group, so the node that --watch keeps running goes with the shell.
    const child = spawn(scripts['dev'] ?? '', {
      cwd: join(dir, 'apps/api'),
      env,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = once(child, 'exit')
    try {
      return await new Promise((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          const line = /owner=(.*)\n/.exec(out)
          if (line?.[1] !== undefined) resolve(JSON.parse(line[1]))
        })
        child.once('exit', () => {
          reject(new Error(`the dev script exited first: ${out}`))
        })
      })
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined)
        process.kill(-child.pid, 'SIGKILL')
      await exited
    }
  }

  it('is empty for the API dev server, even with .env setting it', async () => {
    const withOwner = { ...process.env, MIGRATION_DATABASE_URL: OWNER }
    expect(await apiDevSees(serverEnv(withOwner))).toBe('')
    // Why empty and not deleted: the dev script would load it back from .env.
    const deleted: NodeJS.ProcessEnv = { ...withOwner }
    delete deleted['MIGRATION_DATABASE_URL']
    expect(await apiDevSees(deleted)).toBe(OWNER)
  })

  it('reaches migrate, and not the dev servers', async () => {
    const db = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => db.listen(0, '127.0.0.1', resolve))
    const { port } = db.address() as AddressInfo
    // A pnpm that logs each call and the owner URL it was given.
    const bin = mkdtempSync(join(tmpdir(), '16bit-dev-'))
    const log = join(bin, 'calls.log')
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/bin/sh\nprintf \'%s|%s\\n\' "$*" "${MIGRATION_DATABASE_URL-unset}" >> "$PNPM_LOG"\n',
    )
    chmodSync(join(bin, 'pnpm'), 0o755)

    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./dev.ts', import.meta.url))], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          PNPM_LOG: log,
          DATABASE_URL: `postgres://u:p@127.0.0.1:${String(port)}/db`,
          MIGRATION_DATABASE_URL: OWNER,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      })
      const [code] = (await once(child, 'exit')) as [number | null]
      expect(code).toBe(0)
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        `--filter @16bit/api migrate|${OWNER}`,
        '--parallel --filter @16bit/api --filter @16bit/web dev|',
      ])
    } finally {
      db.close()
    }
  })
})
