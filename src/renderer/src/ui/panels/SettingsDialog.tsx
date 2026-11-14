import { useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import type { AppSettings } from '@shared/ipc'
import { uiStore } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, Dialog, IconButton, Input, NumberInput, Row, Section, Segmented, Spinner } from '@/ui/kit'
import { errorText } from './common/catalog'
import type { DialogPropsBase } from './BomDialog'

type Editable = Pick<AppSettings, 'lang' | 'theme' | 'backend' | 'autosaveSec'>

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
      width="max-w-md"
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
              <Row label={t('Тема')}>
                <Segmented<AppSettings['theme']>
                  value={s.theme}
                  onChange={(v) => void update({ theme: v })}
                  options={[
                    { value: 'dark', label: t('Тёмная') },
                    { value: 'light', label: t('Светлая') },
                  ]}
                  aria-label={t('Тема')}
                />
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
          {error && <p className="text-[#ff8589]">{error}</p>}
        </div>
      )}
    </Dialog>
  )
}
