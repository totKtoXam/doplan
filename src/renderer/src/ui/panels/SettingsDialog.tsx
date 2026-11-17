import { useEffect, useState } from 'react'
import { Eye, EyeOff, FolderOpen, KeyRound } from 'lucide-react'
import type { AppSettings } from '@shared/ipc'
import { uiStore } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, Dialog, IconButton, Input, NumberInput, Row, Section, Segmented, Spinner } from '@/ui/kit'
import { displayName, errorText, useAllAssets, useLang } from './common/catalog'
import '@/ui/catalogI18n'
import type { DialogPropsBase } from './BomDialog'
import { AssetFeedsSection } from './AssetFeedsSection'
import { ThemePicker } from './ThemePicker'

type Editable = Pick<AppSettings, 'lang' | 'theme' | 'backend' | 'autosaveSec' | 'assetFeeds'>

/** application settings (persisted by the main process) */
export function SettingsDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const [s, setS] = useState<AppSettings | null>(null)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState('')
  const [backendChanged, setBackendChanged] = useState(false)
  /** effective default folder for new projects (custom or Documents/doplan) */
  const [projectsDir, setProjectsDir] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setKey('')
    setKeyMsg('')
    setShowKey(false)
    setBackendChanged(false)
    let alive = true
    window.doplan.settings
      .get()
      .then((v) => alive && setS(v))
      .catch((e) => alive && setError(errorText(e)))
    void window.doplan.project
      .defaultLocation()
      .then((p) => alive && setProjectsDir(p))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  const update = async (patch: Partial<Editable>) => {
    setError('')
    if (s) setS({ ...s, ...patch })
    if (patch.lang) uiStore.getState().set({ lang: patch.lang })
    if (patch.theme) uiStore.getState().set({ theme: patch.theme })
    if (patch.backend) setBackendChanged(true)
    try {
      setS(await window.doplan.settings.set(patch))
    } catch (e) {
      setError(errorText(e))
    }
  }

  const changeProjectsDir = async (reset: boolean) => {
    setError('')
    try {
      const next = reset ? await window.doplan.settings.set({ projectsDir: null }) : await window.doplan.project.pickProjectsDir()
      if (next) setS(next)
      setProjectsDir(await window.doplan.project.defaultLocation())
    } catch (e) {
      setError(errorText(e))
    }
  }

  const saveKey = async (value: string | null) => {
    setKeyBusy(true)
    setKeyMsg('')
    try {
      await window.doplan.settings.setApiKey(value)
      setKey('')
      setS(await window.doplan.settings.get())
      setKeyMsg(value ? t('Ключ сохранён') : t('Ключ удалён'))
    } catch (e) {
      setKeyMsg(errorText(e))
    } finally {
      setKeyBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Настройки')}
      width="max-w-lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('Готово')}
        </Button>
      }
    >
      {!s ? (
        <div className="flex justify-center py-8">{error ? <p className="text-[#ff8589]">{error}</p> : <Spinner className="size-5" />}</div>
      ) : (
        <div className="flex flex-col gap-1">
          <Section title={t('Интерфейс')} id="settings-ui">
            <div className="flex flex-col gap-2">
              <Row label={t('Язык')}>
                <Segmented<AppSettings['lang']>
                  value={s.lang}
                  onChange={(v) => void update({ lang: v })}
                  options={[
                    { value: 'ru', label: 'Русский' },
                    { value: 'en', label: 'English' },
                  ]}
                  aria-label={t('Язык')}
                />
              </Row>
              <Row label={t('Тема')} stacked>
                <ThemePicker />
              </Row>
            </div>
          </Section>

          <Section title={t('3D и проекты')} id="settings-3d">
            <div className="flex flex-col gap-2">
              <Row
                label={t('Графика 3D')}
                hint={
                  backendChanged
                    ? t('Изменение вступит в силу после перезапуска приложения.')
                    : t('WebGPU быстрее и нужен для трассировки пути; WebGL — запасной вариант для старых видеокарт.')
                }
              >
                <Segmented<AppSettings['backend']>
                  value={s.backend}
                  onChange={(v) => void update({ backend: v })}
                  options={[
                    { value: 'webgpu', label: 'WebGPU' },
                    { value: 'webgl', label: 'WebGL' },
                  ]}
                  aria-label={t('Графика 3D')}
                />
              </Row>
              <Row label={t('Автосохранение, с')} hint={t('Снимок для восстановления после сбоя; 0 — выключено.')}>
                <NumberInput kind="number" value={s.autosaveSec} min={0} max={3600} step={10} round={1} onChange={(v) => void update({ autosaveSec: Math.round(v) })} />
              </Row>
              {window.doplan.platform !== 'browser' && (
                <Row label={t('Папка проектов')} hint={t('Здесь предлагается создавать новые проекты («Новый проект», «Сохранить как»).')}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-mono text-[11px] text-[var(--text)]" title={projectsDir}>
                      {projectsDir || '…'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => void changeProjectsDir(false)}>
                        {t('Изменить…')}
                      </Button>
                      {s.projectsDir && (
                        <Button size="sm" variant="ghost" onClick={() => void changeProjectsDir(true)}>
                          {t('По умолчанию')}
                        </Button>
                      )}
                    </div>
                  </div>
                </Row>
              )}
            </div>
          </Section>

          <Section title={t('Распознавание плана по фото')} id="settings-ai">
            <div className="flex flex-col gap-2">
              <p className="text-[11px] leading-snug text-[var(--muted)]">
                {t('Для распознавания внутри приложения нужен API-ключ Anthropic. Ключ хранится зашифрованным на этом компьютере. Без ключа можно пользоваться навыком Claude Code (см. «План по фото»).')}
              </p>
              <Row label={t('Статус')}>
                <span className={s.anthropicApiKeySet ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}>
                  {s.anthropicApiKeySet ? t('Ключ задан') : t('Ключ не задан')}
                </span>
              </Row>
              <div className="flex items-center gap-1.5">
                <KeyRound className="size-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={setKey}
                  placeholder={s.anthropicApiKeySet ? t('Новый ключ sk-ant-…') : 'sk-ant-…'}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('API-ключ Anthropic')}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && key.trim()) void saveKey(key.trim())
                  }}
                />
                <IconButton size="sm" icon={showKey ? <EyeOff /> : <Eye />} label={showKey ? t('Скрыть') : t('Показать')} onClick={() => setShowKey(!showKey)} />
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="primary" disabled={!key.trim()} loading={keyBusy} onClick={() => void saveKey(key.trim())}>
                  {t('Сохранить ключ')}
                </Button>
                {s.anthropicApiKeySet && (
                  <Button size="sm" variant="danger" disabled={keyBusy} onClick={() => void saveKey(null)}>
                    {t('Удалить ключ')}
                  </Button>
                )}
                {keyMsg && <span className="text-[10px] text-[var(--muted)]">{keyMsg}</span>}
              </div>
            </div>
          </Section>
          {window.doplan.platform !== 'browser' && <AssetFeedsSection feeds={s.assetFeeds} onChange={(assetFeeds) => void update({ assetFeeds })} />}
          <ModelCredits />
          {error && <p className="text-[#ff8589]">{error}</p>}
        </div>
      )}
    </Dialog>
  )
}

/** CC-BY models need visible attribution: author, source and licence of every such catalog entry */
function ModelCredits() {
  const t = useT()
  const lang = useLang()
  const assets = useAllAssets()
  const credited = assets
    .filter((a) => a.licence?.startsWith('CC-BY') && a.author)
    .sort((a, b) => displayName(a, lang).localeCompare(displayName(b, lang), lang))
  return (
    <Section title={t('Авторы 3D-моделей')} id="settings-credits" defaultOpen={false}>
      <div className="flex flex-col gap-1.5" data-testid="model-credits">
        <p className="text-[11px] leading-snug text-[var(--muted)]">
          {t('Модели Poly Haven, ambientCG и KayKit — CC0. Модели ниже распространяются по CC BY 4.0: автор, источник и лицензия указаны для каждой.')}
        </p>
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1 text-[11px] leading-snug">
          {credited.map((a) => (
            <li key={a.id}>
              <span className="text-[var(--text)]">{displayName(a, lang)}</span>
              <span className="text-[var(--muted)]">{` — ${lang === 'ru' && a.nameRu ? `«${a.name}», ` : ''}${a.author}, ${a.licence}`}</span>
              {a.source && /^https?:/.test(a.source) && <span className="block truncate text-[10px] text-[var(--muted)]">{a.source}</span>}
            </li>
          ))}
          {!credited.length && <li className="text-[var(--muted)]">{t('Нет')}</li>}
        </ul>
      </div>
    </Section>
  )
}
