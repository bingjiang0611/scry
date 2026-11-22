import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { daemonTree, stopBenchDaemon } from './session-open-bench-daemon.mjs'
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

export async function stopConcurrentApp(child, userData) {
  // The daemon outlives the App. Its supervisor owns its shutdown and the
  // fixture's state directory proves which processes belong to this run.
  const tree = daemonTree(userData)
  let app
  let daemon
  try {
    app = await stopOwnedApp(child, { exclude: tree.map(row => row.pid) })
  } finally {
    daemon = await stopBenchDaemon(userData, tree)
  }
  return { ...app, daemon }
}
