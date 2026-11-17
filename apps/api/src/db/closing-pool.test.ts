import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClosingPool, createDb } from './database.ts'
import { createTestDatabase } from './test-database.ts'

// #103: pg-pool's end() resolves before its clients' sockets close, so DROP DATABASE ... WITH
// (FORCE) right after it could terminate a closing client and crash the run with 57P01.

let url: string
let drop: () => Promise<void>

beforeEach(async () => {
  const test = await createTestDatabase()
  url = test.url
  drop = test.drop
})

afterEach(async () => {
  await drop()
})

describe('ClosingPool', () => {
  it('resolves end() only after every client has closed its socket', async () => {
    const pool = new ClosingPool({ connectionString: url, max: 5 })
    const clients: { ended: boolean }[] = []
    pool.on('connect', (client) => {
      const seen = { ended: false }
      clients.push(seen)
      client.once('end', () => {
        seen.ended = true
      })
    })
    // Five concurrent queries open five clients, then all go idle.
    await Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT pg_sleep(0.05)')))
    expect(clients).toHaveLength(5)

    await pool.end()

    expect(clients.every((c) => c.ended)).toBe(true)
  })

  it('resolves end() for a pool that never connected', async () => {
    const pool = new ClosingPool({ connectionString: url })
    await expect(pool.end()).resolves.toBeUndefined()
  })

  it('still reports a real query error', async () => {
    const pool = new ClosingPool({ connectionString: url })
    try {
      await expect(pool.query('SELECT * FROM no_such_table_103')).rejects.toMatchObject({
        code: '42P01',
      })
    } finally {
      await pool.end()
    }
  })
})

describe('createDb then drop', () => {
  // The issue's scenario: several pooled clients, destroy(), then afterEach's FORCE drop at once.
  // A client still closing would surface as an uncaught 57P01 and fail the run.
  it('leaves no closing client for DROP ... WITH (FORCE) to terminate', async () => {
    const db = createDb(url)
    await Promise.all(
      Array.from({ length: 10 }, () => db.selectNoFrom((eb) => eb.val(1).as('one')).execute()),
    )
    await db.destroy()
  })
})
