/** «Добавить в чат» for the inspector header (hidden when nothing is selected). */
import { MessageSquarePlus } from 'lucide-react'
import { useT } from '@/i18n'
import { useUi } from '@/store/ui'
import { IconButton } from '@/ui/kit'
import './i18n'
import { addSelectionToChat } from './store'

export function AddToChatButton() {
  const has = useUi((s) => s.selection.length > 0)
  const tr = useT()
  if (!has) return null
  return <IconButton icon={<MessageSquarePlus />} label={tr('Добавить в чат (Ctrl+L)')} onClick={() => addSelectionToChat()} />
}
