import { sql, type Kysely } from 'kysely'
import net from 'node:net'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
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
// network drop). Unhandled, pg reports it as an `error` event nobody listens to, which crashes the
// process. Vitest fails the run on an uncaught exception, so these tests fail without the pool
// listener in createDb (idle drops) or the per-client listener in ClosingPool (socket errors
// mid-query).
describe('createDb when Postgres drops a pooled connection', () => {
  // Generous, for a loaded parallel run; a passing wait returns as soon as it holds.
  const POLL = { timeout: 5000 }
  let log: MockInstance<typeof console.error>

  beforeEach(() => {
    log = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
  })

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

  /** Resolves once the backend `pid` is running pg_sleep. */
  async function sleepingOn(pid: number): Promise<void> {
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    try {
      await vi.waitFor(async () => {
        const { rows } = await admin.query<{ query: string }>(
          'SELECT query FROM pg_stat_activity WHERE pid = $1',
          [pid],
        )
        expect(rows[0]?.query).toContain('pg_sleep')
      }, POLL)
    } finally {
      await admin.end()
    }
  }

  it('logs and discards a connection terminated while idle, and serves the next query', async () => {
    const db = createDb(url)
    try {
      const pid = await backendPid(db)

      await terminate(pid)

      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledTimes(1)
      }, POLL)
      expect(String(log.mock.calls[0]?.[0])).toMatch(/pooled connection lost \(57P01\)/)
      expect(await backendPid(db)).not.toBe(pid)
    } finally {
      await db.destroy()
    }
  })

  it('fails a query in flight normally and serves the next query', async () => {
    const db = createDb(url)
    try {
      const pid = await backendPid(db)
      const slow = sql`SELECT pg_sleep(30)`.execute(db)
      const outcome = expect(slow).rejects.toMatchObject({ code: '57P01' })
      await sleepingOn(pid)

      await terminate(pid)

      await outcome
      // The 57P01 reaches the query before the socket closes, so the dead client can go back to
      // the pool as idle and fail the very next query once. Wait for the pool to recover.
      await vi.waitFor(async () => {
        expect(await backendPid(db)).not.toBe(pid)
      }, POLL)
      // Postgres sends 57P01, which rejects the query, then closes the socket. If the socket
      // closes after Kysely has released the client, pg-pool's idle listener reports it on the
      // pool and it is logged once; if it closes before, the client is discarded unlogged.
      expect(log.mock.calls.length).toBeLessThanOrEqual(1)
    } finally {
      await db.destroy()
    }
  })

  it('fails a query whose socket is reset mid-query and serves the next query', async () => {
    // A TCP proxy in front of the database, so the test can reset the socket under a running
    // query the way a network drop does: no ErrorResponse from Postgres, just ECONNRESET.
    const target = new URL(url)
    const sockets: net.Socket[] = []
    const proxy = net.createServer((downstream) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname)
      sockets.push(downstream, upstream)
      downstream.on('error', () => {})
      upstream.on('error', () => {})
      downstream.pipe(upstream)
      upstream.pipe(downstream)
    })
    await new Promise<void>((listening) => proxy.listen(0, '127.0.0.1', listening))
    const proxied = new URL(url)
    proxied.hostname = '127.0.0.1'
    proxied.port = String((proxy.address() as net.AddressInfo).port)

    const db = createDb(proxied.toString())
    try {
      const pid = await backendPid(db)
      const slow = sql`SELECT pg_sleep(30)`.execute(db)
      const outcome = expect(slow).rejects.toThrow()
      await sleepingOn(pid)

      for (const socket of sockets.splice(0)) socket.resetAndDestroy()

      await outcome
      // Give any late socket event time to surface as an uncaught exception.
      await new Promise((wait) => setTimeout(wait, 200))
      await expect(backendPid(db)).resolves.toBeTypeOf('number')
    } finally {
      await db.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise((closed) => proxy.close(closed))
    }
  })
})
