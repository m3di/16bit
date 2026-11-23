import { MAX_VIEW_REQUESTS_IN_FLIGHT } from '@16bit/core'
import { ApiRequestError } from '../../api/client.ts'

// View-data and aggregate requests (D83): the API takes up to 4 in flight per principal per
// process and answers the next with 429. A tab keeps its own requests within that, and a 429
// (another tab, the composer's preview) waits and goes again, with no error state: it goes
// once one of this tab's own requests finishes, or after a short wait when none is in flight.

export interface RequestQueueOptions {
  /** Requests in flight at once. */
  limit?: number
  /** 429s in a row before the request fails after all. */
  maxRetries?: number
  /** The wait before a retry when none of this tab's requests is in flight, by attempt. */
  retryDelay?: (attempt: number) => number
}

export interface RequestQueue {
  run<T>(request: () => Promise<T>): Promise<T>
  /** Requests started and not finished; for tests. */
  readonly inFlight: number
}

export const isRateLimited = (error: unknown) =>
  error instanceof ApiRequestError && (error.code === 'rate_limited' || error.status === 429)

/** 250 ms, doubling, at most 4 s. */
export const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 4_000)

interface Task {
  request: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  attempts: number
}

export function createRequestQueue(options: RequestQueueOptions = {}): RequestQueue {
  const limit = options.limit ?? MAX_VIEW_REQUESTS_IN_FLIGHT
  const maxRetries = options.maxRetries ?? 20
  const retryDelay = options.retryDelay ?? backoff
  const waiting: Task[] = []
  // Refused with 429: they go again once another request of ours finishes.
  const parked: Task[] = []
  let inFlight = 0

  function pump() {
    while (inFlight < limit && waiting.length > 0) start(waiting.shift() as Task)
  }

  function start(task: Task) {
    inFlight++
    task.request().then(
      (value) => {
        finish(false)
        task.resolve(value)
      },
      (error: unknown) => {
        if (isRateLimited(error) && task.attempts < maxRetries) {
          task.attempts++
          park(task)
          finish(true)
          return
        }
        finish(false)
        task.reject(error)
      },
    )
  }

  function park(task: Task) {
    parked.push(task)
    // Nothing of ours will finish to wake it: the limit is held elsewhere, so wait a little.
    if (inFlight <= 1) {
      setTimeout(
        () => {
          const i = parked.indexOf(task)
          if (i === -1) return
          parked.splice(i, 1)
          waiting.unshift(task)
          pump()
        },
        retryDelay(task.attempts - 1),
      )
    }
  }

  function finish(refused: boolean) {
    inFlight--
    // One of ours finished, so a slot opened: parked requests go first.
    if (!refused && parked.length > 0) waiting.unshift(...parked.splice(0))
    pump()
  }

  return {
    run<T>(request: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          request,
          resolve: resolve as (value: unknown) => void,
          reject,
          attempts: 0,
        })
        pump()
      })
    },
    get inFlight() {
      return inFlight
    },
  }
}

/** The tab's queue, shared by every view on screen. */
export const viewRequests = createRequestQueue()
