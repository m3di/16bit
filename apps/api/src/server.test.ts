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
