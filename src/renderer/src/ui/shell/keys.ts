/**
 * Layout-independent shortcut key: letters and digits come from the physical key (`e.code`), so
 * shortcuts work on a Russian (or any non-Latin) layout too — there Ctrl+Z arrives as `e.key === 'я'`.
 * Everything else (Delete, Escape, +, …) falls back to `e.key`, lower-cased.
 */
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const m = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(e.code ?? '')
  if (m) return (m[1] ?? m[2] ?? m[3]).toLowerCase()
  return (e.key ?? '').toLowerCase()
}
