/**
 * One writer of a project folder's version history at a time: a GitHub action (send, get, combine
 * versions) and a save from the editor never run side by side. A save made while GitHub is merging
 * would otherwise write the old plan into the half-done merge and commit it.
 */
let chain: Promise<unknown> = Promise.resolve()

/** runs `fn` once everything queued before it has finished (whatever their outcome) */
export function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => undefined)
  return p
}
