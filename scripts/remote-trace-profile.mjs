// Batch E measurement: Mac→Mac remote trace polling for one turn that grows to
// N items. A hidden Electron main runs the real desktop host reader and the real
// DesktopRemoteClient (in-process JSON wire, no TLS); a sandboxed renderer mounts the
// production RemoteChat. The driver applies one host step, then triggers exactly one
// RemoteChat poll and waits two frames.
//
//   node scripts/remote-trace-profile.mjs [--items 1000,5000] [--per-poll 20] [--quiet-every 5] [--out file.json]
//
// Byte/request/commit counts are L1. Milliseconds are controlled L2 only when run
// through .agents/skills/scry-performance-climb/scripts/timing-run.mjs without highLoad.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scales = argument('--items', '1000,5000').split(',').map(Number)
const perPoll = Number(argument('--per-poll', '20'))
const quietEvery = Number(argument('--quiet-every', '5'))
// Fault injection for the delta path: every Nth delta answer claims a base the
// renderer never saw. 0 disables it; timing runs keep it at 0.
const corruptEvery = Number(argument('--corrupt-every', '0'))
const out = argument('--out', '')
const temp = await mkdtemp(join(tmpdir(), 'scry-remote-trace-profile-'))

// `optional` anchors exist only in some revisions (for example the poll backoff state).
function instrument(file, anchor, insertion, optional = false) {
  return {
    name: `instrument-${file}-${insertion.trim()}`, enforce: 'pre',
    transform(code, id) {
      if (id !== join(root, file)) return
      if (optional && !code.includes(anchor)) return
      if (code.split(anchor).length !== 2) throw new Error(`Profile instrumentation anchor changed in ${file}: ${anchor}`)
      return code.replace(anchor, `${anchor}${insertion}`)
    }
  }
}

async function main(webContents, ipcMain, createProfileHost, options) {
  const percentile = (values, p) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((left, right) => left - right)
    return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(3))
  }
  const sum = (values) => values.reduce((total, value) => total + value, 0)
  const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
  const read = (expression) => webContents.executeJavaScript(expression)
  const results = []
  for (const items of options.scales) {
    const host = await createProfileHost({ items, perPoll: options.perPoll, quietEvery: options.quietEvery, corruptEvery: options.corruptEvery })
    let pollCalls = { clientTotalMs: 0, rendererBytes: 0 }
    const allowed = new Set(['catalog', 'trace', 'traceDelta'])
    ipcMain.removeHandler('profile:info')
    ipcMain.removeHandler('profile:call')
    ipcMain.handle('profile:info', () => ({ connectionId: host.connectionId, runId: 'run-profile-e1', cwd: '/fixture/remote-trace', session: 'remote-trace-native' }))
    ipcMain.handle('profile:call', async (_event, method, ...args) => {
      if (!allowed.has(method)) return { ok: false, error: `profile_method_unavailable:${method}`, ms: 0 }
      const started = performance.now()
      try {
        const value = await host.client[method](host.connectionId, ...args)
        const ms = performance.now() - started
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? '')
        if (method !== 'catalog') { pollCalls.clientTotalMs += ms; pollCalls.rendererBytes += bytes }
        return { ok: true, value, ms, bytes }
      } catch (error) {
        const ms = performance.now() - started
        if (method !== 'catalog') pollCalls.clientTotalMs += ms
        return { ok: false, error: error instanceof Error ? error.message : String(error), ms }
      }
    })
    await webContents.loadFile(options.index)
    const deadline = Date.now() + 20_000
    while (!(await read('Boolean(window.__profileActiveRun)'))) {
      if (Date.now() > deadline) throw new Error(`RemoteChat never showed the live run: ${JSON.stringify(await read('window.__profileState?.()'))}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    host.takeWire()
    const samples = []
    for (let step = host.advance(); step; step = host.advance()) {
      pollCalls = { clientTotalMs: 0, rendererBytes: 0 }
      const renderer = await read('window.__profilePoll()')
      const wire = host.takeWire()
      samples.push({
        poll: samples.length + 1, items: step.items, quiet: step.quiet, requests: wire.requests, wireBytes: wire.wireBytes,
        hostMs: wire.hostMs, encodeMs: wire.encodeMs, clientMs: Math.max(0, pollCalls.clientTotalMs - wire.hostMs - wire.encodeMs),
        rendererBytes: pollCalls.rendererBytes, ...renderer
      })
    }
    // Idle tail after the terminal step: shows how far the interval backs off.
    const idleIntervals = []
    for (let index = 0; index < 4; index++) idleIntervals.push((await read('window.__profilePoll()')).pollIntervalMs)
    host.takeWire()
    const state = await read('window.__profileState()')
    const { attachments: _attachments, ...shown } = state.run ?? {}
    const hostView = JSON.parse(host.hostView())
    const consistent = canonical(shown) === canonical(hostView)
    const quiet = samples.filter((sample) => sample.quiet)
    const metric = (key, list = samples) => ({ total: Number(sum(list.map((sample) => sample[key])).toFixed(3)), p50: percentile(list.map((sample) => sample[key]), 0.5), p95: percentile(list.map((sample) => sample[key]), 0.95), max: percentile(list.map((sample) => sample[key]), 1) })
    results.push({
      items, finalItems: hostView.items.length, polls: samples.length, quietPolls: quiet.length,
      traceRequests: sum(samples.map((sample) => sample.traceCalls)), traceErrors: sum(samples.map((sample) => sample.traceErrors)),
      firstErrorAtItems: samples.find((sample) => sample.traceErrors > 0)?.items ?? null,
      wireBytes: metric('wireBytes'), rendererBytes: metric('rendererBytes'), hostMs: metric('hostMs'), encodeMs: metric('encodeMs'), clientMs: metric('clientMs'),
      traceIpcMs: metric('traceMs'), commits: metric('commits'),
      // Interval RemoteChat requested after each poll (null when the revision has no backoff).
      pollIntervals: [...new Set(samples.map((sample) => sample.pollIntervalMs))],
      intervalAfterQuiet: [...new Set(quiet.map((sample) => sample.pollIntervalMs))], commitMs: metric('commitMs'), wallMs: metric('wallMs'),
      quiet: { wireBytes: metric('wireBytes', quiet), commits: metric('commits', quiet), commitMs: metric('commitMs', quiet) },
      idleIntervals, consistent, shownItems: Array.isArray(shown.items) ? shown.items.length : null, pollError: state.pollError, unexpectedBridgeCalls: state.unexpected,
      samples
    })
    await host.dispose()
  }
  return results
}

try {
  await Promise.all(['home', 'userData', 'sessionData', 'host'].map((name) => mkdir(join(temp, name))))
  await build({
    // Bundle dependencies too: the hidden main runs from a temp directory without node_modules.
    configFile: false, root, logLevel: 'error', ssr: { noExternal: true },
    build: { ssr: join(root, 'scripts/fixtures/remote-trace-host.ts'), outDir: join(temp, 'host'), emptyOutDir: false, minify: false, target: 'node20',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'host.cjs' } } }
  })
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    plugins: [
      instrument('src/renderer/hooks/useVisibilityPolling.ts', '  refreshRef.current = refresh\n', '  window.__visibilityPolls?.set(key, () => refreshRef.current())\n'),
      instrument('src/renderer/components/RemoteChat.tsx', '  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)\n', '  window.__profileActiveRun = activeRun\n'),
      instrument('src/renderer/components/RemoteChat.tsx', '  const [pollIntervalMs, setPollIntervalMs] = useState(POLL_MS)\n', '  window.__profilePollInterval = pollIntervalMs\n', true)
    ],
    // Production React with the profiling renderer, so <Profiler> reports commit durations.
    resolve: { alias: [{ find: '@shared', replacement: join(root, 'src/shared') }, { find: /^react-dom$/, replacement: 'react-dom/profiling' }] },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false, target: 'es2022',
      lib: { entry: join(root, 'scripts/fixtures/remote-trace-profile.tsx'), formats: ['iife'], name: 'ScryRemoteTraceProfile', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100vh"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'preload.cjs'), `
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('profileHost', {
      info: () => ipcRenderer.invoke('profile:info'),
      call: (method, ...args) => ipcRenderer.invoke('profile:call', method, ...args)
    });
  `)
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow, ipcMain } = require('electron');
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
    app.on('browser-window-focus', () => { console.error('Profile fixture stole native window focus'); app.exit(1); });
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))});
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))});
    app.whenReady().then(async () => {
      const { createProfileHost } = require(${JSON.stringify(join(temp, 'host', 'host.cjs'))});
      const win = new BrowserWindow({ title: 'Scry remote trace profile', show: false, width: 1100, height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: ${JSON.stringify(join(temp, 'preload.cjs'))} } });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('console-message', (event) => { if (event.level === 'error' || event.level === 3) console.error(event.message) });
      try {
        const result = await (${main.toString()})(win.webContents, ipcMain, createProfileHost, ${JSON.stringify({ scales, perPoll, quietEvery, corruptEvery, index: join(temp, 'index.html') })});
        require('node:fs').writeFileSync(${JSON.stringify(join(temp, 'result.json'))}, JSON.stringify(result));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    }).catch((error) => { console.error(error); app.exit(1); });
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(argument('--timeout-ms', '600000')))
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Remote trace profile failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else resolve()
    })
  })
  const results = JSON.parse(await readFile(join(temp, 'result.json'), 'utf8'))
  if (out) await writeFile(out, JSON.stringify({ perPoll, quietEvery, corruptEvery, results }, null, 2))
  console.log(`SCRY_REMOTE_TRACE_PROFILE=${JSON.stringify({ perPoll, quietEvery, corruptEvery, results: results.map(({ samples: _samples, ...summary }) => summary) })}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
