import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme, browserThemeStorage, readStoredTheme } from './theme'
import { installRendererPerformanceMonitor } from './performance-monitor'
import { detectRendererPlatform } from './platform'
import './styles.css'
import './motion.css'
import './analytics-evidence.css'
import './inventory-evidence.css'
import './session-evidence.css'
import './codex-alignment.css'

document.documentElement.dataset.platform = detectRendererPlatform()
const syncPageVisibility = (): void => {
  document.documentElement.dataset.pageVisibility = document.visibilityState
}
syncPageVisibility()
document.addEventListener('visibilitychange', syncPageVisibility)
applyTheme(readStoredTheme(browserThemeStorage()), document.documentElement)

let disposePerformanceMonitor: (() => void) | null = null
void window.scry.performanceDiagnosticsEnabled?.().then((enabled) => {
  if (!enabled || typeof window.scry.reportRendererPerformance !== 'function') return
  disposePerformanceMonitor = installRendererPerformanceMonitor((sample) => {
    void window.scry.reportRendererPerformance?.(sample).catch(() => {})
  })
}).catch(() => {})
window.addEventListener('pagehide', () => {
  document.removeEventListener('visibilitychange', syncPageVisibility)
  disposePerformanceMonitor?.()
  disposePerformanceMonitor = null
}, { once: true })

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
