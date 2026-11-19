/**
 * Failures of the Pages calls by kind, so the caller acts on what happened, not on the wording of a
 * (translated) message. No imports: the flow tests throw these from their fakes.
 */

/** limited: GitHub's rate limit (try later); token: the token lacks a permission (sign in again) */
export type PagesErrorKind = 'auth' | 'forbidden' | 'limited' | 'token' | 'notFound' | 'network' | 'unknown'

/** a GitHub refusal of a Pages call; the message is for the user */
export class PagesGhError extends Error {
  constructor(
    message: string,
    readonly kind: PagesErrorKind,
    /** the HTTP status GitHub answered with */
    readonly status?: number,
  ) {
    super(message)
  }
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
