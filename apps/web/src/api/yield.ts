/**
 * Ends the current task so the browser can render and handle input before the next slice of
 * work, as D61's "no main-thread task over 50 ms" needs for large reads (issue 218).
 * `scheduler.yield` where the browser has it; otherwise a message to ourselves, which runs as
 * the next task without the minimum delay a timer gets.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      resolve()
    }
    port2.postMessage(null)
  })
}
