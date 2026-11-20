/**
 * Whether the browser keeps refusing to capture the mouse (Pointer Lock) in walk mode. A refusal
 * soon after the capture ended is temporary (Chromium refuses a re-lock for about a second after
 * Esc), however many clicks it takes, so the next click must still only capture the mouse. Only
 * refusals out of that window, on separate clicks (a double click is one), with no capture in
 * between, mean the capture will not come (an iframe without allow-pointer-lock, no permission);
 * clicks then act at the cursor. Leaving walk mode or switching the capture setting starts over.
 */
export interface LockRefusals {
  /** a `pointerlockerror` at `now` (ms) */
  refused(now: number): void
  /** the mouse was captured */
  locked(): void
  /** the capture ended at `now` (ms): refusals for a while after are the browser's cooldown */
  unlocked(now: number): void
  /** forget the refusals (walk mode left, the capture setting changed) */
  reset(): void
  /** the capture keeps failing: clicks act at the cursor */
  persistent(): boolean
}

export interface LockRefusalOptions {
  /** refusals this soon after the capture ended are the browser's re-lock cooldown, ms */
  cooldown?: number
  /** refusals this close to the last counted one belong to the same click (a double click), ms */
  gesture?: number
  /** counted refusals that make it persistent */
  limit?: number
}

export function createLockRefusals(opts: LockRefusalOptions = {}): LockRefusals {
  const cooldown = opts.cooldown ?? 1500
  const gesture = opts.gesture ?? 500
  const limit = opts.limit ?? 2
  let count = 0
  let lastUnlock = -Infinity
  let lastCounted = -Infinity
  return {
    refused(now) {
      if (now - lastUnlock < cooldown || now - lastCounted < gesture) return
      count++
      lastCounted = now
    },
    locked() {
      count = 0
      lastCounted = -Infinity
    },
    unlocked(now) {
      lastUnlock = now
    },
    reset() {
      count = 0
      lastCounted = -Infinity
    },
    persistent: () => count >= limit,
  }
}
