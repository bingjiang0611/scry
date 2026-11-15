// Shared harness for the Claude history real-App measurements (claude-session-open-bench.mjs and
// claude-history-acceptance.mjs): per-run fixture generation through the production archive writer,
// a hidden-window Electron
// bootstrap, main-process perf-trace capture, and a percentile summary.
//
// The bootstrap and switches mirror scripts/session-open-bench.mjs: production main/preload/
// renderer, isolated userData/HOME/workspace, hidden window, Chromium sandbox kept on, every
// Provider disabled so no CLI or SDK can run. History reads do not need Provider execution.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electron from 'electron'

/**
 * Writes the fixture for this run through the production archive writer. A copy is not usable:
 * segment sidecars stamp inode/ctime, so cloning the template invalidates them and the App would
 * silently fall back to the complete archive read instead of the paged path under test.
 */
export function generateClaudeFixture({ generatorRoot, tempDir, sessions }) {
  const root = join(tempDir, 'fixture')
  const spec = {
    userDataDir: join(root, 'userData'),
    home: join(root, 'home'),
    cwd: join(root, 'workspace'),
    sessions
  }
  const specPath = join(tempDir, 'fixture-spec.json')
  writeFileSync(specPath, JSON.stringify(spec))
  const started = Date.now()
  const generated = spawnSync(join(generatorRoot, 'node_modules/.bin/vite-node'),
    [join(generatorRoot, 'scripts/claude-session-open-fixture.ts'), specPath], { encoding: 'utf8' })
  const line = generated.stdout?.split('\n').find(entry => entry.startsWith('SCRY_CLAUDE_FIXTURE='))
  if (generated.status !== 0 || !line) {
    throw new Error(`fixture generation failed (${generated.status}): ${(generated.stderr ?? '').slice(-2000)}`)
  }
  const report = JSON.parse(line.slice('SCRY_CLAUDE_FIXTURE='.length))
  return { ...report, generationMs: Date.now() - started }
}

/** Wraps the built App so the driver owns startup and can see renderer milestones. */
export function writeClaudeBootstrap(root, temp) {
  const bootstrap = join(temp, 'app')
  mkdirSync(bootstrap)
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'main.cjs' }))
  writeFileSync(join(bootstrap, 'main.cjs'), `
    const { app } = require('electron');
    const mark = (phase, detail = {}) => process.stderr.write('[scry:native-startup] ' + JSON.stringify({ phase, pid: process.pid, atMs: performance.now(), ...detail }) + '\\n');
    mark('bootstrap', { ready: app.isReady() });
    app.once('ready', () => mark('app-ready'));
    app.on('browser-window-created', (_event, win) => {
      mark('window-created', { windowId: win.id });
      win.webContents.once('did-finish-load', () => mark('renderer-loaded', { windowId: win.id }));
      win.webContents.on('did-fail-load', (_event, code, description) => mark('renderer-load-failed', { code, description }));
    });
    app.setAppPath(${JSON.stringify(root)});
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    require(${JSON.stringify(join(root, metadata.main))});
    mark('main-loaded');
  `)
  return bootstrap
}

export function claudeAppEnv(home) {
  return {
    ...process.env,
    HOME: home,
    SCRY_TEST_APP: '1',
    SCRY_PERF_LOG: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    SCRY_ELECTRON_SMOKE_PROVIDER: '1',
    // Fixture adapters for claude/codex/pi: history reads need a registered adapter per Provider,
    // and the smoke set never spawns a real CLI.
    SCRY_ELECTRON_SMOKE_CONVERSATIONS: '1',
    // Claude stays enabled so the renderer treats the session as openable, but nothing is executed:
    // the driver only opens existing history and never sends a prompt. The other Providers are off.
    SCRY_DISABLED_PROVIDERS: 'codex,qoder,opencode,pi',
    SCRY_REMOTE_HOST: '0'
  }
}

/**
 * Spawns the built App and captures `[scry:perf]` samples in arrival order. A sample is printed
 * when main finishes the work, so a driver can slice traces per measurement by list index.
 */
export function launchClaudeApp({ root, bootstrap, userData, home, port, extraArgs = [] }) {
  const child = spawn(electron, [bootstrap, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run',
    ...extraArgs], {
    env: claudeAppEnv(home),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const traces = []
  const startup = []
  let output = ''
  let lineBuffer = ''
  const capture = chunk => {
    const text = String(chunk)
    output += text
    lineBuffer += text
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.includes('[scry:perf]')) {
        try { traces.push(JSON.parse(line.slice(line.indexOf('{')))) } catch { /* a torn line is not evidence */ }
      }
      if (line.includes('[scry:native-startup]')) {
        try { startup.push(JSON.parse(line.slice(line.indexOf('{')))) } catch { /* ignore */ }
      }
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return {
    child,
    traces,
    startup,
    output: () => `${output}${lineBuffer}`,
    traceCount: () => traces.length
  }
}

/** Trace checkpoints of one `session_history.load` sample as flat stage → milliseconds. */
export function sampleStages(sample) {
  const stages = {}
  for (const checkpoint of sample.checkpoints ?? []) stages[checkpoint.stage] = checkpoint.deltaMs
  return stages
}

export function sampleCounters(sample) {
  const counters = {}
  for (const checkpoint of sample.checkpoints ?? []) Object.assign(counters, checkpoint.counters ?? {})
  return counters
}

export const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Nearest-rank percentile; with 12 samples p95 is the largest observed value. */
export const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]

export function summarise(samples) {
  const values = samples.map(sample => sample.openMs)
  return { n: values.length, medianMs: median(values), p95Ms: percentile(values, 0.95), minMs: Math.min(...values), maxMs: Math.max(...values) }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Hash of the measurement code, so an A/B pair can prove both sides ran the same harness. */
export function harnessSha256(root, files) {
  const digest = createHash('sha256')
  for (const path of files) digest.update(`${path}\0${sha256File(join(root, path))}\n`)
  return digest.digest('hex')
}

export function buildSha256(root) {
  const artifactDir = join(root, 'out')
  const digest = createHash('sha256')
  for (const path of readdirSync(artifactDir, { recursive: true }).sort()) {
    if (!statSync(join(artifactDir, path)).isFile()) continue
    digest.update(`${path}\0${sha256File(join(artifactDir, path))}\n`)
  }
  return digest.digest('hex')
}
