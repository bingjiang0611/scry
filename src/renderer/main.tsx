import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme, browserThemeStorage, readStoredTheme } from './theme'
import './styles.css'

applyTheme(readStoredTheme(browserThemeStorage()), document.documentElement)

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
