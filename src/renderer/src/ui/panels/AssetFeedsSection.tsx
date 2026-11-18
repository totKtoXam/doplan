import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { cleanFeedUrl, DEFAULT_FEEDS, MAX_FEEDS, type AssetFeed } from '@shared/feeds'
import { useT } from '@/i18n'
import { Button, IconButton, Input, Section, Toggle } from '@/ui/kit'

/**
 * Settings → asset feeds: where on-demand catalog entries are downloaded from (NuGet-style sources).
 * The first enabled feed that has an entry wins; the built-in ones can be switched off and moved, not removed.
 */
export function AssetFeedsSection({ feeds, onChange }: { feeds: AssetFeed[]; onChange(next: AssetFeed[]): void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= feeds.length) return
    const next = feeds.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const add = () => {
    const clean = cleanFeedUrl(url)
    if (!clean) {
      setErr(t('Нужен адрес https://… или полный путь к папке'))
      return
    }
    if (feeds.some((f) => f.url === clean)) {
      setErr(t('Такой источник уже есть'))
      return
    }
    setErr('')
    onChange([...feeds, { id: `feed-${Date.now().toString(36)}`, name: name.trim() || clean, url: clean, enabled: true }])
    setName('')
    setUrl('')
  }
  const isDefault = JSON.stringify(feeds) === JSON.stringify(DEFAULT_FEEDS)
  const noneEnabled = !feeds.some((f) => f.enabled)

  return (
    <Section title={t('Источники ресурсов')} id="settings-feeds" defaultOpen={false}>
      <div className="flex flex-col gap-2" data-testid="asset-feeds">
        <p className="text-[11px] leading-snug text-[var(--muted)]">
          {t('Откуда скачиваются модели, материалы и HDRI, которых нет в установке. Источники перебираются сверху вниз: берётся первый включённый, где элемент есть.')}
        </p>
        <ul className="flex flex-col gap-1">
          {feeds.map((f, i) => (
            <li key={f.id} className="flex items-center gap-1.5 rounded border border-[var(--border)] px-1.5 py-1">
              <Toggle size="sm" checked={f.enabled} onChange={(v) => onChange(feeds.map((x) => (x.id === f.id ? { ...x, enabled: v } : x)))} title={t('Включён')} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-[var(--text)]">
                  {f.id === 'doplan' ? t('doplan (свой репозиторий)') : f.id === 'upstream' ? t('Исходные сайты') : f.name}
                </div>
                <div className="truncate font-mono text-[10px] text-[var(--muted)]" title={f.url ?? undefined}>
                  {f.url ?? f.name}
                </div>
              </div>
              <IconButton size="sm" icon={<ArrowUp />} label={t('Выше')} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton size="sm" icon={<ArrowDown />} label={t('Ниже')} disabled={i === feeds.length - 1} onClick={() => move(i, 1)} />
              {!f.builtin && (
                <IconButton size="sm" variant="danger" icon={<Trash2 />} label={t('Удалить')} onClick={() => onChange(feeds.filter((x) => x.id !== f.id))} />
              )}
            </li>
          ))}
        </ul>
        {noneEnabled && <p className="text-[11px] text-[#ff8589]">{t('Все источники отключены: скачать ничего не получится.')}</p>}
        {feeds.length < MAX_FEEDS + DEFAULT_FEEDS.length && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Input value={name} onChange={setName} placeholder={t('Название')} aria-label={t('Название источника')} onKeyDown={(e) => e.stopPropagation()} />
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={url}
                onChange={(v) => {
                  setUrl(v)
                  setErr('')
                }}
                placeholder="https://…/  ·  D:\doplan-feed"
                spellCheck={false}
                aria-label={t('Адрес источника')}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && url.trim()) add()
                }}
              />
              <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!url.trim()} onClick={add}>
                {t('Добавить')}
              </Button>
            </div>
            {err && <p className="text-[11px] text-[#ff8589]">{err}</p>}
          </div>
        )}
        {!isDefault && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => onChange(DEFAULT_FEEDS.map((f) => ({ ...f })))}>
              {t('По умолчанию')}
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}
