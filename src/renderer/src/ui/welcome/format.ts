/** Text helpers of the welcome screen (pure: tested without a DOM). */

type Tr = (key: string, vars?: Record<string, string | number>) => string

const DAY = 24 * 60 * 60 * 1000

/** «сегодня, 14:05» / «вчера, 9:30» / «3 мар 2026» */
export function formatWhen(iso: string, lang: 'ru' | 'en', t: Tr, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const locale = lang === 'en' ? 'en-GB' : 'ru-RU'
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / DAY)
  if (days === 0) return t('сегодня, {time}', { time })
  if (days === 1) return t('вчера, {time}', { time })
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** the folder a project lives in, shown under its name */
export function parentOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  if (parts.length < 2) return path
  const sep = path.includes('\\') ? '\\' : '/'
  return parts.slice(0, -1).join(sep) || sep
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
