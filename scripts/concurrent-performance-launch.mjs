import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeEntryPackage } from './smoke-app-entries.mjs'

export function writeConcurrentAppEntry(bootstrap, root, probe) {
  const entry = join(bootstrap, 'main.cjs')
  writeEntryPackage(entry)
  writeFileSync(entry, `
    const { app } = require('electron');
    app.setAppPath(${JSON.stringify(root)});
    require(${JSON.stringify(probe)});
    // Hidden native fixture, but foreground renderer workload (including visibility-gated polling).
    app.on('browser-window-created', (_event, win) => win.webContents.setBackgroundThrottling(false));
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    require(${JSON.stringify(join(root, 'out/main/index.js'))});
  `)
}
