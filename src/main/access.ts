import { resolve } from 'node:path'
import { isRecentPath } from './settings'

/**
 * Paths the renderer may read by path: those chosen in a native dialog, opened via OS association /
 * CLI / second instance, or present in the recent-projects list. Everything else is refused, so a
 * compromised renderer cannot read arbitrary files.
 */
const granted = new Set<string>()

const norm = (p: string) => resolve(p).toLowerCase()

export function grantPath(p: string): void {
  granted.add(norm(p))
}

export async function assertReadable(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !p) throw new Error('Не указан путь к файлу')
  const full = resolve(p)
  if (granted.has(norm(full))) return full
  if (await isRecentPath(full)) return full
  throw new Error('Нет доступа к файлу: выберите его через диалог открытия')
}
