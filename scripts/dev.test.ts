import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureEnvFile, waitForDatabase } from './dev.ts'

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
