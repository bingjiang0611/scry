import { app } from 'electron'
import { applyAppStartupGuards } from './daemon-mode-default'

// Side-effect import, kept first in src/main/index.ts (see daemon-mode-default.ts).
try {
  applyAppStartupGuards(process.env, {
    userDataDir: app.getPath('userData'),
    appDataDir: app.getPath('appData'),
    appName: app.getName()
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  app.exit(1)
  throw error
}
