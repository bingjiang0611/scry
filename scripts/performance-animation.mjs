// Isolated, hidden GPU-enabled fixture. CPU samples do not represent foreground
// compositing. No Scry userData, preload or Provider runs.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-animation-perf-'))
try {
  for (const name of ['home', 'userData', 'sessionData']) await mkdir(join(temp, name))
  for (const name of ['styles', 'codex-alignment']) await copyFile(join(root, `src/renderer/${name}.css`), join(temp, `${name}.css`))
  await writeFile(join(temp, 'index.html'), `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'">
    <link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="codex-alignment.css">
    <style>body{margin:0;padding:24px}.sb-sess{height:36px}body.legacy .sb-sess .sb-running{animation-play-state:running;animation-duration:.75s;animation-timing-function:linear}</style>
    <h3>Scry · isolated animation measurement</h3><p>Eight synthetic running sessions. Closes automatically.</p>
    <aside class="sidebar">${Array.from({ length: 8 }, (_, i) => `<div class="sb-sess ${i === 0 ? 'active' : ''}"><span class="sb-running" role="status" aria-label="正在运行"></span><span class="sb-sesstext">Synthetic session ${i + 1}</span></div>`).join('')}</aside>`)
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    const { performance } = require('node:perf_hooks')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
    const snapshot = () => app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, cpuSeconds: p.cpu.cumulativeCPUUsage }))
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 600, height: 500, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const samples = []
        // ABBA reduces one-way warmup/drift bias. CPU is one-core %, not machine %.
        for (const legacy of [true, false, false, true]) {
          const style = await win.webContents.executeJavaScript(
            'document.body.classList.toggle("legacy", ' + legacy + '); ({ count:document.querySelectorAll(".sb-running").length, animated:document.getAnimations().filter(a => a.playState === "running" && a.effect.target.matches(".sb-running")).length })'
          )
          if (style.count !== 8 || style.animated !== (legacy ? 8 : 1)) throw new Error('Animation condition did not apply: ' + JSON.stringify(style))
          await wait(700)
          const before = snapshot(), started = performance.now()
          await wait(3000)
          const elapsedMs = performance.now() - started
          const after = snapshot()
          const processes = after.filter(p => ['GPU', 'Tab', 'Browser'].includes(p.type)).map(p => {
            const previous = before.find(b => b.pid === p.pid)
            if (p.cpuSeconds == null || previous?.cpuSeconds == null) throw new Error('CPU evidence unavailable or process restarted')
            return { type: p.type, oneCoreCpuPercent: Number(((p.cpuSeconds - previous.cpuSeconds) / (elapsedMs / 1000) * 100).toFixed(2)) }
          })
          if (!processes.some(p => p.type === 'GPU')) throw new Error('No GPU process evidence')
          samples.push({ legacy, animatedSpinners: style.animated, elapsedMs: Math.round(elapsedMs), processes })
        }
        console.log('SCRY_ANIMATION_PERF=' + JSON.stringify({ electron: process.versions.electron, windowVisibility: 'hidden', samples }))
        win.destroy()
        app.quit()
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs')], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_ANIMATION_PERF=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error('Animation measurement failed (' + (code ?? signal) + '):\n' + output))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
