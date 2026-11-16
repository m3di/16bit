import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const server = fileURLToPath(new URL('./server.ts', import.meta.url))

describe('server', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('closes and exits 0 on %s', async (signal) => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        // Never connected to in this test: the pool is lazy and no request is made.
        DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
        DEV_API_KEY: 'test-key',
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
  it('refuses to start without DEV_API_KEY', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0', DATABASE_URL: 'postgres://x@h/db' }
    delete env['DEV_API_KEY']
    const child = spawn(process.execPath, [server], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(1)
    expect(stderr).toContain('DEV_API_KEY')
  })

  it('refuses DEV_ANONYMOUS_AS_OWNER on a non-loopback HOST', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '0',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
      DEV_API_KEY: 'test-key',
      DEV_ANONYMOUS_AS_OWNER: 'true',
    }
    delete env['DEV_ANONYMOUS_ALLOW_NONLOCAL']
    const child = spawn(process.execPath, [server], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(1)
    expect(stderr).toContain('refusing to start')
  })
})
