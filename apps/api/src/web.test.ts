import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp, type AppOptions } from './app.ts'
import { createDb, type Database } from './db/database.ts'

// No request here reaches the database: the pool is lazy and never connects.

const html = { accept: 'text/html,application/xhtml+xml' }

let root: string
let db: Kysely<Database>
let app: FastifyInstance

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), '16bit-web-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="app"></div>')
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)')
  db = createDb('postgres://unused@127.0.0.1:1/unused')
})

afterAll(async () => {
  await db.destroy()
  rmSync(root, { recursive: true, force: true })
})

afterEach(async () => {
  await app.close()
})

function start(options: Partial<AppOptions> = {}): FastifyInstance {
  app = buildApp({ db, webRoot: root, ...options })
  return app
}

describe('web app', () => {
  it('serves index.html at / without long caching', async () => {
    const res = await start().inject({ url: '/', headers: html })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('id="app"')
  })

  it('serves fingerprinted assets as immutable', async () => {
    const res = await start().inject({ url: '/assets/index-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('does not mark index.html immutable when the root itself sits under an assets directory', async () => {
    const nested = join(root, 'assets', 'site')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'index.html'), '<!doctype html><div id="app"></div>')
    const res = await start({ webRoot: nested }).inject({ url: '/', headers: html })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('answers a client-side route with index.html', async () => {
    const res = await start().inject({ url: '/hubs/build?tab=table', headers: html })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('id="app"')
  })

  it('keeps a 404 for a missing asset', async () => {
    const res = await start().inject({ url: '/assets/gone.js', headers: html })
    expect(res.statusCode).toBe(404)
  })

  it('keeps JSON 404s under /v1, even for a browser', async () => {
    const res = await start().inject({
      url: '/v1/nope',
      headers: html,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found', message: 'Route not found' })
  })

  it('does not serve the web app when webRoot is unset', async () => {
    const res = await start({ webRoot: undefined }).inject({ url: '/', headers: html })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })
})

describe('API auth beside the web app', () => {
  // D41 is retired: the image no longer lets anonymous requests act as an owner. Auth runs
  // before any handler, so these never reach the (unreachable) database.
  it.each([undefined, '', 'Bearer wrong', 'Bearer dev-only-key'])(
    'refuses /v1/workspaces with authorization %j',
    async (authorization) => {
      const res = await start().inject({
        url: '/v1/workspaces',
        headers: authorization === undefined ? {} : { authorization },
      })
      expect(res.statusCode).toBe(401)
    },
  )
})
