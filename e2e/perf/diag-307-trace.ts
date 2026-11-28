// TEMPORARY (issue 307): summarises Chromium traces of the scroll budget. For each renderer
// main-thread task over 30 ms: its length and the events inside it, by total time.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface Ev {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: { name?: string; data?: { url?: string; functionName?: string } }
}

function find(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...find(p))
    else if (/^trace-307-.*\.json$/.test(name)) out.push(p)
  }
  return out
}

for (const file of process.argv.slice(2).flatMap((d) => find(d))) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { traceEvents?: Ev[] } | Ev[]
  const events = Array.isArray(raw) ? raw : (raw.traceEvents ?? [])
  const mains = new Set(
    events
      .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map((e) => `${String(e.pid)}:${String(e.tid)}`),
  )
  const onMain = events.filter((e) => e.ph === 'X' && mains.has(`${String(e.pid)}:${String(e.tid)}`))
  const tasks = onMain.filter(
    (e) => (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask') && (e.dur ?? 0) > 30_000,
  )
  console.log(`== ${file}: ${String(tasks.length)} main-thread tasks over 30 ms`)
  const t0 = onMain.reduce((m, e) => Math.min(m, e.ts), Infinity)
  for (const task of tasks) {
    const end = task.ts + (task.dur ?? 0)
    const inside = onMain.filter(
      (e) => e !== task && e.pid === task.pid && e.tid === task.tid && e.ts >= task.ts && e.ts < end,
    )
    const byName = new Map<string, number>()
    for (const e of inside) {
      const label =
        e.name === 'FunctionCall' || e.name === 'EvaluateScript' || e.name === 'v8.callFunction'
          ? `${e.name}(${e.args?.data?.functionName ?? ''} ${(e.args?.data?.url ?? '').split('/').pop() ?? ''})`
          : e.name
      byName.set(label, (byName.get(label) ?? 0) + (e.dur ?? 0))
    }
    const top = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([n, d]) => `${n} ${(d / 1000).toFixed(1)}`)
      .join('; ')
    console.log(
      `  task @${((task.ts - t0) / 1000).toFixed(0)} ms: ${((task.dur ?? 0) / 1000).toFixed(1)} ms | ${top}`,
    )
  }
}
