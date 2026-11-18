import { app } from 'electron'
import { applyDaemonModeDefault } from './daemon-mode-default'

// Side-effect import, kept first in src/main/index.ts (see daemon-mode-default.ts).
applyDaemonModeDefault(process.env, { isPackaged: app.isPackaged })
