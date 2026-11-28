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
  args?: {
    name?: string
    elementCount?: number
    data?: { url?: string; functionName?: string; reason?: string; nodeName?: string; elementCount?: number }
  }
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
  const reasons = new Map<string, number>()
  for (const e of events)
    if (e.name === 'StyleRecalcInvalidationTracking' || e.name === 'StyleInvalidatorInvalidationTracking') {
      const k = `${e.name.replace('InvalidationTracking', '')} ${e.args?.data?.reason ?? ''} ${e.args?.data?.nodeName ?? ''}`
      reasons.set(k, (reasons.get(k) ?? 0) + 1)
    }
  console.log(
    '  invalidations: ' +
      [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k} x${String(n)}`).join('; '),
  )
  const all = onMain
    .filter((e) => e.name === 'ThreadControllerImpl::RunTask' && (e.dur ?? 0) > 8_000)
    .map((e) => (e.dur ?? 0) / 1000)
    .sort((a, b) => a - b)
  const q = (f: number) => (all[Math.floor(f * (all.length - 1))] ?? 0).toFixed(1)
  const variant = /repeat(\d+)/.exec(file)?.[1]
  console.log(
    `STATS ${Number(variant ?? 0) % 2 === 1 ? 'B-no-pulse' : 'A-baseline'} tasks>8ms ${String(all.length)} p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)} over30 ${String(all.filter((d) => d > 30).length)} over40 ${String(all.filter((d) => d > 40).length)}`,
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
    const styled = inside
      .filter((e) => e.name === 'UpdateLayoutTree')
      .reduce((n, e) => n + (e.args?.elementCount ?? e.args?.data?.elementCount ?? 0), 0)
    byName.set(`elements styled ${String(styled)}`, 0)
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
