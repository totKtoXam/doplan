/**
 * What the app starts with: an empty plan behind the welcome screen. The welcome screen is skipped when
 * the app was launched to open a file (that file opens instead); a crash-recovery copy is offered over
 * it as before (restoring it loads the document, which closes the screen).
 */
import { createEmptyDoc } from '@core'
import { startupView } from '@shared/recent'
import { loadDocument } from '@/actions/project'
import { t } from '@/i18n'
import { api } from '@/store/api'
import { showWelcome } from '@/store/welcome'
import { installRecentThumbs } from './thumbnail'

export async function prepareStartup(): Promise<'file' | 'welcome'> {
  try {
    loadDocument(createEmptyDoc(t('Новый проект')), null)
  } catch (err) {
    console.error('[doplan] empty document failed', err)
  }
  let launch: { file: boolean } | null = null
  try {
    launch = await api.recent.launch()
  } catch (err) {
    console.warn('[doplan] recent.launch failed', err)
  }
  const view = startupView(launch)
  if (view === 'welcome') showWelcome(false)
  installRecentThumbs()
  return view
}
