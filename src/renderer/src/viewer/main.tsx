/**
 * Entry of the published plan viewer (viewer.html → out/viewer): loads view-plan.json / view-catalog.json
 * from the page's folder and shows the plan read-only in 2D and 3D. No Electron: `@/store/api`
 * installs its browser fallback.
 */
import '../store/api'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { setViewOnly } from '@/store/viewOnly'
import { ViewerApp } from './ViewerApp'

setViewOnly(true)

const el = document.getElementById('root') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'root' }))
createRoot(el).render(<ViewerApp />)
