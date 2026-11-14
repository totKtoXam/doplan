/** «Добавить в чат» for the inspector header (hidden when nothing is selected). */
import { MessageSquarePlus } from 'lucide-react'
import { useUi } from '@/store/ui'
import { IconButton } from '@/ui/kit'
import { addSelectionToChat } from './store'

export function AddToChatButton() {
  const has = useUi((s) => s.selection.length > 0)
  if (!has) return null
  return <IconButton icon={<MessageSquarePlus />} label="Добавить в чат (Ctrl+L)" onClick={() => addSelectionToChat()} />
}
