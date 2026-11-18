/**
 * Failures of the Pages calls by kind, so the caller acts on what happened, not on the wording of a
 * (translated) message. No imports: the flow tests throw these from their fakes.
 */

export type PagesErrorKind = 'auth' | 'forbidden' | 'notFound' | 'network' | 'unknown'

/** a GitHub refusal from gh; the message is for the user */
export class PagesGhError extends Error {
  constructor(
    message: string,
    readonly kind: PagesErrorKind,
    /** the HTTP status gh reported, when it did */
    readonly status?: number,
  ) {
    super(message)
  }
}

/** the HTTP status in gh's output ("HTTP 403", "(HTTP 403)") */
export function httpStatus(out: string): number | undefined {
  const m = /\bHTTP (\d{3})\b/.exec(out)
  return m ? Number(m[1]) : undefined
}

/**
 * The signed-in account may not change the repository: GitHub refused a Pages call, or the git
 * server refused a push (raw git output, never a translated message).
 */
export function isNoAccess(e: unknown): boolean {
  if (e instanceof PagesGhError) return e.kind === 'forbidden'
  const stderr = (e as { stderr?: unknown } | null)?.stderr
  return typeof stderr === 'string' && /\b403\b|Permission to \S+ denied/i.test(stderr)
}
