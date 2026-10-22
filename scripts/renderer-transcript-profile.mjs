// Isolated production renderer profile (App/component); NOT a main/Provider benchmark.
// Run with .agents/skills/scry-performance-climb/scripts/timing-run.mjs.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-transcript-profile-'))
const controls = process.argv.includes('--controls')
const fullApp = process.argv.includes('--app')
const anchors = {
  'App.tsx': [['App', '  const [theme, setTheme] = useState<AppTheme>']],
  'Sidebar.tsx': [['Sidebar', '  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null)']],
  'ChatView.tsx': [
    ['ChatView', "  const [composerMenu, setComposerMenu] = useState"],
    ['ChatTranscriptTurns', '  const windowed = shouldWindowTranscript(turns)'],
    ['TranscriptTurn', '  const selected = useMemo(() => selectedId != null'],
    ['releaseChecks', '    const release = (focusTarget: Node | null) => {', false]
  ],
  'ChatTurn.tsx': [['AssistantTurn', '  const [forking, setForking] = useState(false)']],
  'MarkdownImpl.tsx': [['Markdown', '  const sampledChildren = useSampledMarkdownSource(children, streaming)']]
}

// Runs before React; observe actual listener/observer lifetimes, not source-code counts.
function bootstrap() {
  window.profileCounts = {}
  window.profileAppBodyMs = []
  window.profileResources = {}
  for (const name of ['IntersectionObserver', 'MutationObserver', 'ResizeObserver']) {
    const Native = window[name]
    window[name] = class extends Native {
      observe(...args) {
        if (!this.tracked) { this.tracked = true; window.profileResources[name] = (window.profileResources[name] ?? 0) + 1 }
        return super.observe(...args)
      }
      disconnect() {
        if (this.tracked) { this.tracked = false; window.profileResources[name]-- }
        return super.disconnect()
      }
    }
  }
  // Bracket the native event's production listeners; exclude per-callback timer overhead.
  const nativeAdd = document.addEventListener.bind(document)
  let selectionStarted = 0
  window.profileSelectionMs = []
  nativeAdd('selectionchange', () => { selectionStarted = performance.now() })
  window.profileStartSelectionTiming = () => nativeAdd('selectionchange', () => {
    window.profileSelectionMs.push(performance.now() - selectionStarted)
  })
  const listeners = new Set()
  for (const name of ['addEventListener', 'removeEventListener']) {
    const native = document[name].bind(document)
    document[name] = (type, listener, options) => {
      if (type === 'selectionchange') {
        if (name === 'addEventListener') listeners.add(listener)
        else listeners.delete(listener)
        window.profileResources.selectionListeners = listeners.size
      }
      return native(type, listener, options)
    }
  }
  window.profileLongTasks = []
  window.profileLongTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask')
  if (window.profileLongTasksSupported) new PerformanceObserver(list => {
    window.profileLongTasks.push(...list.getEntries().map(entry => entry.duration))
  }).observe({ type: 'longtask', buffered: true })
}

async function exercise(contents, controls, fullApp) {
  const read = expression => contents.executeJavaScript(expression, true)
  const frame = () => read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = expression => read(`(async () => {
    const deadline = performance.now() + 5000;
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('Profile condition timed out: ' + ${JSON.stringify(expression)});
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  })()`)
  const snapshot = () => read(`({counts: {...profileCounts}, resources: {...profileResources},
    shells: document.querySelectorAll('.transcript-turn').length,
    mounted: document.querySelectorAll('.transcript-turn:not([data-virtualized])').length,
    domNodes: document.querySelectorAll('*').length, selectionDispatchMs: [...profileSelectionMs], appBodyBeforeJsxMs: [...profileAppBodyMs],
    longTasks: profileLongTasksSupported ? [...profileLongTasks] : {availability: 'unavailable', reason: 'Chromium longtask observer unsupported'}})`)
  const delta = (before, after) => Object.fromEntries(Object.keys(after.counts).map(key => [key, after.counts[key] - (before.counts[key] ?? 0)]))
  const stats = values => {
    if (values.length === 0) return {availability: 'unavailable', reason: 'No samples in this phase'}
    const sorted = [...values].sort((a, b) => a - b)
    return { samples: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }
  }
  if (fullApp) {
    await wait('document.querySelector(".sb-sess") != null')
    const point = await read('(() => { const rect = document.querySelector(".sb-sess").getBoundingClientRect(); return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; })()')
    contents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, ...point})
    contents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, ...point})
  }
  await wait('document.querySelectorAll(".transcript-turn").length > 0 && typeof profileStream === "function"')
  const viewport = await read('(() => { const element = document.querySelector(".chat-transcript"); return {width: element.clientWidth, height: element.clientHeight}; })()')
  if (viewport.height < 300 || viewport.height > 850 || viewport.width < 600) throw new Error(`Invalid transcript viewport: ${JSON.stringify(viewport)}`)
  await read('document.querySelector(".chat-transcript").scrollTop = document.querySelector(".chat-transcript").scrollHeight')
  await wait('document.querySelector(".transcript-turn:last-child .turn-assistant") != null')
  await frame()
  const initial = await snapshot()
  await read('document.querySelector("textarea").focus()')
  await frame()
  await read('profileStartSelectionTiming()')
  const beforeTyping = await snapshot()
  const typingMs = []
  for (let index = 0; index < 30; index++) {
    const start = await read('performance.now()')
    contents.insertText('x')
    await wait(`document.querySelector('textarea').value.length === ${index + 1}`)
    await frame()
    typingMs.push(await read('performance.now()') - start)
  }
  const afterTyping = await snapshot()
  const streamMs = []
  for (let index = 0; index < 30; index++) {
    const start = await read('performance.now()')
    await read(`profileStream(${index})`)
    await wait(`profileCounts.ChatTranscriptTurns > ${afterTyping.counts.ChatTranscriptTurns + index}`)
    await frame()
    streamMs.push(await read('performance.now()') - start)
  }
  const afterStream = await snapshot()
  const beforeSelection = await snapshot()
  // Real browser Selection API events, not manually dispatched synthetic selectionchange.
  for (let index = 0; index < 10; index++) {
    await read(`(() => { const selection = getSelection(); selection.removeAllRanges();
      if (${index % 2} === 0) selection.selectAllChildren(document.querySelector('.transcript-turn:last-child .model-text')); })()`)
    await frame()
  }
  const afterSelection = await snapshot()
  const typingCommits = delta(beforeTyping, afterTyping)
  const streamCommits = delta(afterTyping, afterStream)
  if (typingCommits.ChatTranscriptTurns !== 0 || typingCommits.AssistantTurn !== 0 || typingCommits.Markdown !== 0) throw new Error('Typing executed transcript/Markdown work')
  if (streamCommits.AssistantTurn !== 30 || streamCommits.TranscriptTurn !== 30) throw new Error(`Unrelated turns rerendered: ${JSON.stringify(streamCommits)}`)
  if (afterStream.mounted >= 40) throw new Error(`Unbounded mounted content: ${afterStream.mounted}`)
  if (controls && (afterSelection.counts.releaseChecks - beforeSelection.counts.releaseChecks) > 400) throw new Error('Selection fanout grows with history')
  if (controls && (afterSelection.resources.IntersectionObserver !== 1 || afterSelection.resources.MutationObserver > afterSelection.mounted + (fullApp ? 1 : 0) || afterSelection.resources.selectionListeners > 2)) throw new Error(`Observer/listener ownership grows with history: ${JSON.stringify({resources: afterSelection.resources, mounted: afterSelection.mounted})}`)
  await read('profileUnmount()')
  await frame()
  const unmounted = await snapshot()
  if (unmounted.resources.IntersectionObserver !== 0 || unmounted.resources.MutationObserver !== 0 || unmounted.resources.ResizeObserver !== 0 || unmounted.resources.selectionListeners !== 1) throw new Error(`Unmount leaked resources: ${JSON.stringify(unmounted.resources)}`)
  return { viewport, initial, unmounted, typing: { commits: typingCommits, appBodyBeforeJsxMs: stats(afterTyping.appBodyBeforeJsxMs.slice(beforeTyping.appBodyBeforeJsxMs.length)), longTasks: afterTyping.longTasks, roundTripTwoFrameMs: stats(typingMs), selectionDispatchMs: stats(afterTyping.selectionDispatchMs.slice(beforeTyping.selectionDispatchMs.length)) },
    streaming: { commits: streamCommits, appBodyBeforeJsxMs: stats(afterStream.appBodyBeforeJsxMs.slice(afterTyping.appBodyBeforeJsxMs.length)), longTasks: afterStream.longTasks, roundTripTwoFrameMs: stats(streamMs) },
    selection: { releaseChecks: afterSelection.counts.releaseChecks - beforeSelection.counts.releaseChecks, resources: afterSelection.resources, dispatchMs: stats(afterSelection.selectionDispatchMs.slice(beforeSelection.selectionDispatchMs.length)) },
    final: afterSelection,
    scope: fullApp ? 'production App + offline renderer bridge' : 'production SessionChatView component' }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map(name => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'profile-production-components', enforce: 'pre', transform(source, id) {
      const entries = anchors[id.split('/').at(-1)]
      if (!entries || !id.startsWith(join(root, 'src/renderer/'))) return
      let code = "import { useLayoutEffect as profileCommit } from 'react'\n" + source
      for (const [key, anchor, commit = true] of entries) {
        if (code.split(anchor).length !== 2) throw new Error(`Profile anchor changed: ${key}`)
        const increment = `window.profileCounts.${key} = (window.profileCounts.${key} ?? 0) + 1;`
        code = code.replace(anchor, commit ? `  profileCommit(() => { ${increment} })\n${anchor}` : `${anchor}\n      ${increment}`)
      }
      if (id === join(root, 'src/renderer/App.tsx')) {
        const start = 'export function App() {'
        const end = '  return (\n    <div\n      className={`app app-shell'
        if (code.split(start).length !== 2 || code.split(end).length !== 2) throw new Error('App body timing anchor changed')
        code = code.replace(start, `${start}\n  const profileAppStarted = performance.now()`)
          .replace(end, `  window.profileAppBodyMs.push(performance.now() - profileAppStarted)\n${end}`)
      }
      return code
    } }],
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/renderer-transcript-profile.tsx'), formats: ['iife'],
        name: 'ScryTranscriptProfile', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'bootstrap.js'), `(${bootstrap.toString()})()`)
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root" class="main-area" style="height:750px"></div><script src="bootstrap.js"></script><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
    app.on('window-all-closed', () => {});
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))});
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))});
    app.whenReady().then(async () => {
      try {
        const results = [];
        for (const turns of [200, 1000]) {
          const win = new BrowserWindow({ show: false, width: 1100, height: 850,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
          win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel: !details.url.startsWith('file:')}));
          win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
          win.webContents.on('console-message', event => console.error(event.message));
          await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, {query: {turns: String(turns), ...(${fullApp} ? {app: '1'} : {})}});
          win.webContents.focus();
          const result = await (${exercise.toString()})(win.webContents, ${controls}, ${fullApp});
          const memory = app.getAppMetrics().find(metric => metric.pid === win.webContents.getOSProcessId()).memory;
          results.push({turns, ...result, memory});
          win.destroy();
        }
        console.log('SCRY_TRANSCRIPT_PROFILE=' + JSON.stringify({electron: process.versions.electron, results}));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_TRANSCRIPT_PROFILE=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Transcript profile failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally { await rm(temp, { recursive: true, force: true }) }
