// installs the browser fallback for window.doplan before any other module can touch it
import './store/api'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/golos-text'
import './styles.css'
// applies the colour theme before the first paint
import './theme/store'
import { App } from './App'

const el = document.getElementById('root') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'root' }))

// no StrictMode: double-mounting would create the WebGPU device / Pixi context twice
createRoot(el).render(<App />)
