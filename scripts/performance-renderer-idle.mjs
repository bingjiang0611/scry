// Controlled A/B of production diagnostics and activity sweep. Hidden offscreen
// rendering includes GPU readback, so CPU is not a foreground-App estimate.
// Run under .agents/skills/scry-performance-climb/scripts/timing-run.mjs.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-renderer-idle-'))

async function exercise(app, win) {
  const read = expression => win.webContents.executeJavaScript(expression)
  await read(`(async () => {
    const deadline = performance.now() + 5000
    while (!document.querySelector('#activity-sidebar-view-activity')) {
      if (performance.now() > deadline) throw new Error('Sidebar did not mount')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  })()`)
  const point = await read(`(() => {
    const rect = document.querySelector('#activity-sidebar-view-activity').getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await read(`(async () => {
    const deadline = performance.now() + 5000
    while (document.querySelectorAll('.sb-activity-item[data-activity-group="working"]').length !== 2) {
      if (performance.now() > deadline) throw new Error('Activity view did not open')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  })()`)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const metrics = () => app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, cpuSeconds: p.cpu.cumulativeCPUUsage }))
  let paints = 0
  win.webContents.on('paint', () => { paints++ })
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Performance.enable')
  const durations = async () => Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const samples = []
  // Reverse the complete four-condition order to expose warmup/drift.
  for (const condition of [0, 1, 2, 3, 3, 2, 1, 0]) {
    const monitor = (condition & 1) === 0
    const sweep = (condition & 2) === 0
    const state = await read(`(() => {
      cpuExperiment.setMonitor(${monitor})
      for (const animation of document.getAnimations()) {
        if (animation.animationName === 'sb-activity-sweep') animation.${sweep ? 'play' : 'pause'}()
      }
      return {
        visibility: document.visibilityState,
        rows: document.querySelectorAll('.sb-activity-item[data-activity-group="working"]').length,
        sweeps: document.getAnimations().filter(a => a.animationName === 'sb-activity-sweep' && a.playState === 'running').length
      }
    })()`)
    if (state.visibility !== 'visible' || state.rows !== 2 || state.sweeps !== (sweep ? 2 : 0)) throw new Error('Condition not applied: ' + JSON.stringify(state))
    // Fixed settling and observation windows, not retries or test-timeout padding.
    await wait(700)
    const beforeDurations = await durations()
    const before = metrics(), beforePaints = paints, started = performance.now()
    const beforeFrames = await read('cpuExperiment.frames')
    await wait(3000)
    const elapsedMs = performance.now() - started
    const after = metrics(), afterDurations = await durations()
    const afterFrames = await read('cpuExperiment.frames')
    const processes = after.filter(p => ['GPU', 'Tab', 'Browser'].includes(p.type)).map(p => {
      const previous = before.find(b => b.pid === p.pid)
      if (p.cpuSeconds == null || previous?.cpuSeconds == null) throw new Error('Missing CPU evidence or process restarted')
      return { type: p.type, cpuMs: (p.cpuSeconds - previous.cpuSeconds) * 1000,
        oneCoreCpuPercent: (p.cpuSeconds - previous.cpuSeconds) * 100_000 / elapsedMs }
    })
    if (!processes.some(p => p.type === 'GPU')) throw new Error('Missing GPU evidence')
    const renderer = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']
      .map(key => {
        if (afterDurations[key] == null || beforeDurations[key] == null) throw new Error('Missing CDP metric ' + key)
        return [key, afterDurations[key] - beforeDurations[key]]
      }))
    samples.push({ monitor, sweep, elapsedMs, paints: paints - beforePaints, frameCallbacks: afterFrames - beforeFrames, processes, renderer })
  }
  await read('cpuExperiment.setMonitor(false)')
  win.webContents.debugger.detach()
  return { scope: 'production Sidebar fixture, two running rows, hidden offscreen GPU rendering with readback; frame/observer overhead only: each condition ends before the 5s reporting interval, report callback is a no-op, no reporting IPC or journal I/O', samples }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map(name => mkdir(join(temp, name))))
  await writeFile(join(temp, 'entry.ts'), `
    import ${JSON.stringify(join(root, 'scripts/fixtures/sidebar-activity-smoke.tsx'))}
    import { installRendererPerformanceMonitor } from ${JSON.stringify(join(root, 'src/renderer/performance-monitor.ts'))}
    let dispose: (() => void) | undefined
    const nativeFrame = window.requestAnimationFrame.bind(window)
    const state = { frames: 0, setMonitor(enabled: boolean) {
      dispose?.()
      dispose = enabled ? installRendererPerformanceMonitor(() => {}) : undefined
    } }
    window.requestAnimationFrame = callback => nativeFrame(time => { state.frames++; callback(time) })
    Object.assign(window, { cpuExperiment: state })
  `)
  await build({ configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(temp, 'entry.ts'), formats: ['iife'], name: 'ScryIdleProfile', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:">
    <link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`)
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 1200, height: 900, show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
      win.webContents.setFrameRate(120)
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const result = await (${exercise.toString()})(app, win)
        console.log('SCRY_RENDERER_IDLE=' + JSON.stringify({ electron: process.versions.electron, ...result }))
        win.destroy()
        app.quit()
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-backgrounding-occluded-windows'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_RENDERER_IDLE=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Renderer idle measurement failed (${code ?? signal}):\n${output}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
