import { LayoutGrid } from 'lucide-react'
import { showWelcome } from '@/store/welcome'
import type { MenuEntry } from '@/ui/shell/primitives'
import './welcomeI18n'

/** «Файл → Начальный экран» of the in-app menu (the native menu sends the 'welcome' command) */
export const welcomeMenuEntry = (t: (key: string) => string): MenuEntry => ({
  label: t('Начальный экран'),
  icon: LayoutGrid,
  onSelect: () => showWelcome(true),
})
