/**
 * Lightweight timing of the 3D view (area: 3d-rendering).
 *
 * Every measurement is a `performance.measure()` entry named `doplan:<name>` (visible in the
 * DevTools performance panel) and is kept in a small ring buffer exposed as `window.__doplanPerf`.
 *
 * Debug output is off by default. Turn it on with `localStorage.setItem('doplan.perf', '1')`
 * (or `window.__doplanPerf.enable()`): every measurement is then logged to the console and a small
 * overlay in the 3D view lists the latest values. `window.__doplanPerf.summary()` prints a table
 * of min / median / max per name at any time.
 */

export interface PerfEntry {
  name: string
  ms: number
  at: number
  detail?: string
}

const MAX_ENTRIES = 400
const entries: PerfEntry[] = []
const listeners = new Set<() => void>()
const open = new Map<string, number>()

function readFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem('doplan.perf') === '1'
  } catch {
    return false
  }
}

let enabled = readFlag()

export function perfEnabled(): boolean {
  return enabled
}

/** records a finished measurement that started at `start` (a `performance.now()` value) */
export function perfRecord(name: string, start: number, detail?: string): number {
  const end = performance.now()
  const ms = end - start
  try {
    performance.measure(`doplan:${name}`, { start, end, detail })
  } catch {
    /* the User Timing API is optional */
  }
  entries.push({ name, ms, at: end, detail })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (enabled) console.info(`[perf] ${name}: ${ms.toFixed(1)} ms${detail ? ` (${detail})` : ''}`)
  for (const cb of Array.from(listeners)) {
    try {
      cb()
    } catch {
      /* overlay only */
    }
  }
  return ms
}

/** times a synchronous block */
export function perfTime<T>(name: string, fn: () => T, detail?: string): T {
  const start = performance.now()
  try {
    return fn()
  } finally {
    perfRecord(name, start, detail)
  }
}

/** times an async block */
export async function perfTimeAsync<T>(name: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    perfRecord(name, start, detail)
  }
}

/** starts a span that is closed later by `perfEnd` (keyed: a restart moves the start) */
export function perfBegin(key: string, at = performance.now()): void {
  open.set(key, at)
}

/** starts a span only when none is open for the key (the first trigger wins) */
export function perfBeginOnce(key: string, at = performance.now()): void {
  if (!open.has(key)) open.set(key, at)
}

export function perfPending(key: string): boolean {
  return open.has(key)
}

/** closes a span started with `perfBegin`; returns the duration or -1 when none was open */
export function perfEnd(key: string, name = key, detail?: string): number {
  const start = open.get(key)
  if (start === undefined) return -1
  open.delete(key)
  return perfRecord(name, start, detail)
}

export function perfCancel(key: string): void {
  open.delete(key)
}

export function perfEntries(): PerfEntry[] {
  return entries.slice()
}

export function perfLast(name: string): PerfEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].name === name) return entries[i]
  return undefined
}

export function onPerf(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

interface SummaryRow {
  name: string
  n: number
  last: number
  min: number
  median: number
  max: number
}

export function perfSummary(filter?: string): SummaryRow[] {
  const by = new Map<string, number[]>()
  const last = new Map<string, number>()
  for (const e of entries) {
    if (filter && !e.name.includes(filter)) continue
    let list = by.get(e.name)
    if (!list) by.set(e.name, (list = []))
    list.push(e.ms)
    last.set(e.name, e.ms)
  }
  const rows: SummaryRow[] = []
  const r = (v: number) => Math.round(v * 10) / 10
  for (const [name, list] of by) {
    const sorted = list.slice().sort((a, b) => a - b)
    rows.push({
      name,
      n: list.length,
      last: r(last.get(name) ?? 0),
      min: r(sorted[0]),
      median: r(sorted[Math.floor(sorted.length / 2)]),
      max: r(sorted[sorted.length - 1]),
    })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

function setEnabled(on: boolean): void {
  enabled = on
  try {
    if (on) globalThis.localStorage?.setItem('doplan.perf', '1')
    else globalThis.localStorage?.removeItem('doplan.perf')
  } catch {
    /* storage may be unavailable */
  }
  for (const cb of Array.from(listeners)) cb()
}

const api = {
  entries: perfEntries,
  last: perfLast,
  summary(filter?: string) {
    const rows = perfSummary(filter)
    console.table(rows)
    return rows
  },
  clear() {
    entries.length = 0
  },
  enable() {
    setEnabled(true)
  },
  disable() {
    setEnabled(false)
  },
  get enabled() {
    return enabled
  },
}
;(globalThis as unknown as { __doplanPerf?: typeof api }).__doplanPerf = api

/**
 * Debug overlay listing the latest measurements; only shown while the debug flag is on.
 * Returns a disposer.
 */
export function mountPerfOverlay(container: HTMLElement): () => void {
  const el = document.createElement('div')
  el.style.cssText =
    'position:absolute;left:8px;bottom:12px;z-index:5;pointer-events:none;font:10px/1.35 ui-monospace,monospace;' +
    'color:#e8edf3;background:rgba(10,14,20,.72);padding:4px 6px;border-radius:4px;white-space:pre;max-width:46ch'
  let raf = 0
  const draw = (): void => {
    raf = 0
    if (!enabled) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'block'
    const rows = perfSummary()
    el.textContent = rows.length ? rows.map((row) => `${row.name.padEnd(26)} ${row.last.toFixed(1).padStart(8)} ms`).join('\n') : 'perf: no samples yet'
  }
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(draw)
  }
  container.appendChild(el)
  const off = onPerf(schedule)
  draw()
  return () => {
    off()
    if (raf) cancelAnimationFrame(raf)
    el.remove()
  }
}
