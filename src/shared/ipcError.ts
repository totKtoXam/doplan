/**
 * An error thrown in the main process reaches the renderer as
 * "Error invoking remote method '<channel>': Error: <message>". The user should see only <message>.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

export function stripIpcPrefix(message: string): string {
  return message.replace(IPC_PREFIX, '')
}

/** the same error with the IPC prefix taken off its message (anything else is returned as it is) */
export function cleanIpcError(err: unknown): unknown {
  if (!(err instanceof Error) || !IPC_PREFIX.test(err.message)) return err
  const clean = new Error(stripIpcPrefix(err.message))
  if (err.stack) clean.stack = err.stack
  return clean
}
