import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../db/test-database.ts'
import { Listener } from './listener.ts'

// The `LISTEN` connection on its own (#171): it reports `connected` on every successful connect,
// the first one included, even when that first connect only succeeds after failed attempts.

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Resolves once `predicate` holds, polling; fails after `ms`. */
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Listener', () => {
  it('reports connected after a first connect that failed, and then hears notifications', async () => {
    const test = await createTestDatabase()
    cleanup.push(test.drop)
    // A database that does not exist yet: every attempt fails until it does.
    const missing = new URL(test.appUrl)
    const name = `${missing.pathname.slice(1)}_late`
    missing.pathname = `/${name}`
    let connected = 0
    const heard: string[] = []
    const listener = new Listener(
      missing.toString(),
      {
        connected: () => (connected += 1),
        notification: (channel, payload) => heard.push(`${channel}:${payload}`),
      },
      { retryMs: 20, maxRetryMs: 50 },
    )
    cleanup.push(() => listener.close())
    await listener.start()
    expect(listener.listening).toBe(false)
    expect(connected).toBe(0)

    const owner = new pg.Client({ connectionString: test.url })
    await owner.connect()
    try {
      await owner.query(`CREATE DATABASE ${name}`)
    } finally {
      await owner.end()
    }
    cleanup.push(async () => {
      const c = new pg.Client({ connectionString: test.url })
      await c.connect()
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await c.end()
      }
    })

    await until(() => listener.listening)
    expect(connected).toBe(1)

    const late = new URL(test.url)
    late.pathname = `/${name}`
    const sender = new pg.Client({ connectionString: late.toString() })
    await sender.connect()
    try {
      await sender.query(`SELECT pg_notify('revision', 'w1:7')`)
    } finally {
      await sender.end()
    }
    await until(() => heard.length > 0)
    expect(heard).toEqual(['revision:w1:7'])

    // A health check on a healthy connection keeps it: no reconnect.
    await listener.check(5000)
    expect(listener.listening).toBe(true)
    expect(connected).toBe(1)
  })
})
