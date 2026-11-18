import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClosingPool, createDb, type Database } from './database.ts'
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

// #107: Postgres can drop a pooled connection at any time (a restart, pg_terminate_backend, a
// network drop). pg-pool reports it as the pool's `error` event, which crashes the process with an
// uncaught exception unless someone listens. Vitest fails the run on an uncaught exception, so
// these tests would fail without the listener in createDb.
describe('createDb when Postgres drops a pooled connection', () => {
  async function backendPid(db: Kysely<Database>): Promise<number> {
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
    const pid = rows[0]?.pid
    if (pid === undefined) throw new Error('no backend pid')
    return pid
  }

  async function terminate(pid: number): Promise<void> {
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    try {
      const { rows } = await admin.query<{ done: boolean }>(
        'SELECT pg_terminate_backend($1) AS done',
        [pid],
      )
      expect(rows[0]?.done).toBe(true)
    } finally {
      await admin.end()
    }
  }

  it('discards a connection terminated while idle and serves the next query', async () => {
    const errors: Error[] = []
    const db = createDb(url, { onPoolError: (error) => errors.push(error) })
    try {
      const pid = await backendPid(db)

      await terminate(pid)

      await vi.waitFor(() => {
        expect(errors).toHaveLength(1)
      })
      expect(errors[0]).toMatchObject({ code: '57P01' })
      const next = await backendPid(db)
      expect(next).not.toBe(pid)
    } finally {
      await db.destroy()
    }
  })

  it('fails a query in flight normally and serves the next query', async () => {
    const errors: Error[] = []
    const db = createDb(url, { onPoolError: (error) => errors.push(error) })
    try {
      const pid = await backendPid(db)
      const slow = sql`SELECT pg_sleep(30)`.execute(db)
      const outcome = expect(slow).rejects.toMatchObject({ code: '57P01' })
      // Wait until the sleep is running on that backend, then terminate it.
      const admin = new pg.Client({ connectionString: url })
      await admin.connect()
      try {
        await vi.waitFor(async () => {
          const { rows } = await admin.query<{ query: string }>(
            'SELECT query FROM pg_stat_activity WHERE pid = $1',
            [pid],
          )
          expect(rows[0]?.query).toContain('pg_sleep')
        })
      } finally {
        await admin.end()
      }

      await terminate(pid)

      await outcome
      expect(await backendPid(db)).not.toBe(pid)
      // The socket closing after the failed query reaches the pool as an error too, or not at
      // all; either way it is handled and nothing more.
      expect(errors.length).toBeLessThanOrEqual(1)
    } finally {
      await db.destroy()
    }
  })

  it('logs a dropped connection by default', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createDb(url)
    try {
      await terminate(await backendPid(db))

      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledTimes(1)
      })
      expect(String(log.mock.calls[0]?.[0])).toMatch(/pooled connection lost \(57P01\)/)
      await expect(backendPid(db)).resolves.toBeTypeOf('number')
    } finally {
      log.mockRestore()
      await db.destroy()
    }
  })
})
