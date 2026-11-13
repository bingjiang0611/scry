console.log('Interaction fixture main started', Date.now())
const { app, BrowserWindow } = require('electron')
const [html, userData, totalDeadline] = process.argv.slice(2)
const startedAt = Date.now()
let readyAt
let loadRequestedAt
let phase = 'startup'
let phaseDeadline
let watchdog
let lastCondition

const finish = code => { clearTimeout(watchdog); app.exit(code) }
const timedOut = () => {
  console.error('Interaction fixture timed out', JSON.stringify({ phase, startedAt, readyAt, loadRequestedAt, phaseDeadline, totalDeadline: Number(totalDeadline), now: Date.now(), lastCondition }))
  finish(3)
}
const arm = nextPhase => {
  phase = nextPhase
  phaseDeadline = Math.min(Date.now() + 15000, Number(totalDeadline))
  clearTimeout(watchdog)
  watchdog = setTimeout(timedOut, Math.max(0, phaseDeadline - Date.now()))
}
arm('startup')
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
app.on('browser-window-focus', () => { console.error('UI fixture stole native window focus'); finish(1) })
app.setPath('userData', userData)
app.whenReady().then(() => {
  readyAt = Date.now()
  if (readyAt >= phaseDeadline) { timedOut(); return }
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
  if (!win.webContents.isOffscreen()) { console.error('Offscreen rendering is required'); finish(1); return }
  win.webContents.once('did-finish-load', () => {
    // A queued load event must not revive an already exhausted startup/total budget.
    if (Date.now() >= phaseDeadline) { timedOut(); return }
    console.log('Interaction fixture loaded', JSON.stringify({ startedAt, readyAt, loadRequestedAt, loadedAt: Date.now() }))
    arm('interaction')
  })
  win.webContents.on('render-process-gone', (_event, details) => { console.error('Interaction renderer exited', details.reason); finish(2) })
  win.webContents.on('did-fail-load', (_event, code, description) => { console.error('Interaction load failed', code, description); finish(2) })
  win.webContents.on('console-message', event => {
    const message = event.message || ''
    if (message.startsWith('Interaction condition:')) lastCondition = message
    console.log(message)
    if (message.includes('SCRY_RENAME_TEST')) {
      if (Date.now() >= phaseDeadline) timedOut()
      else finish(message.includes('_OK') ? 0 : 1)
    }
  })
  loadRequestedAt = Date.now()
  win.loadFile(html)
})
