import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme, browserThemeStorage, readStoredTheme } from './theme'
import './styles.css'
import './analytics-evidence.css'
import './diagnostics-evidence.css'
import './inventory-evidence.css'
import './session-evidence.css'

document.documentElement.dataset.platform =
  navigator.userAgent.includes('Electron') && navigator.platform.startsWith('Mac') ? 'macos' : 'other'
applyTheme(readStoredTheme(browserThemeStorage()), document.documentElement)

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
