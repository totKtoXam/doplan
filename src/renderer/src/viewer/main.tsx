/**
 * Entry of the published plan viewer (viewer.html → out/viewer): loads view-plan.json / view-catalog.json
 * from the page's folder and shows the plan read-only in 2D and 3D. No Electron: `@/store/api`
 * installs its browser fallback.
 */
import '../store/api'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { parseViewerParams } from '@shared/pagesSite'
import { setViewOnly } from '@/store/viewOnly'
import { ViewerApp } from './ViewerApp'

setViewOnly(true)

// a link that opens in 3D starts the 3D code and the overview picture now, alongside the plan's
// files, not after them (the 2D code waits until the 3D view is there or the plan is asked for)
const early = parseViewerParams(location.search)
if (early.view === '3d') {
  void import('@/view3d').catch(() => undefined)
  if (early.cam === 'orbit' && !early.level) {
    const link = Object.assign(document.createElement('link'), { rel: 'preload', as: 'image', href: 'assets/preview.webp' })
    document.head.appendChild(link)
  }
}

const el = document.getElementById('root') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'root' }))
createRoot(el).render(<ViewerApp />)
