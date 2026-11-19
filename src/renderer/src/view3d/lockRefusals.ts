/**
 * Whether the browser keeps refusing to capture the mouse (Pointer Lock) in walk mode. One refusal
 * is often temporary (Chromium refuses a re-lock within about a second after Esc, or the window is
 * not focused yet), so the next click must still only capture the mouse; only refusals in a row,
 * with no capture in between, mean the capture will not come (an iframe without allow-pointer-lock)
 * and clicks then act at the cursor.
 */
export interface LockRefusals {
  /** a `pointerlockerror` */
  refused(): void
  /** the mouse was captured */
  locked(): void
  /** the capture keeps failing: clicks act at the cursor */
  persistent(): boolean
}

export function createLockRefusals(limit = 2): LockRefusals {
  let count = 0
  return {
    refused() {
      count++
    },
    locked() {
      count = 0
    },
    persistent: () => count >= limit,
  }
}
