// Real-App L2 bench for opening a Claude session: click a sidebar conversation, then wait for the
// authoritative transcript-built history (`.chat-transcript[aria-busy="false"]
// [data-history-source="authoritative"]`), the newest turn visible, and an usable composer.
//
// Unlike scripts/session-open-bench.mjs this fixture is a Claude session: a Provider transcript
// JSONL plus the segmented archive written by production capture (scripts/claude-session-open-
// fixture.ts). Both the baseline `a464aff` build and the paged build read the same fixture, so the
// A/B difference is the history code and nothing else.
//
//   node scripts/claude-session-open-bench.mjs --root <worktree> --out <json>
//     [--path paged|complete] [--warmups 2] [--iterations 12]
//
// Measurement code only: it never edits the App, and the driver wraps every run in
// .agents/skills/scry-performance-climb/scripts/timing-run.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'
import { connect, freePort, startupProbe } from './session-open-fixture.mjs'
import { measureNativeSessionOpen } from './session-open-timing.mjs'
import {
  buildSha256, generateClaudeFixture, harnessSha256, launchClaudeApp, sampleCounters, sampleStages,
  summarise, writeClaudeBootstrap
} from './claude-session-open-harness.mjs'

// The timed interval is bounded, never trimmed: a complete (pre-paging) open can exceed a minute
// on a loaded host, and the sample must record that instead of timing out.
const MEASURE_DEADLINE_MS = 240000

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const options = { root, out: null, path: 'paged', warmups: 2, iterations: 12 }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
  assert.ok(Object.hasOwn(options, key), `unknown option: ${process.argv[index]}`)
  options[key] = key === 'warmups' || key === 'iterations' ? Number(process.argv[index + 1]) : process.argv[index + 1]
}
assert.ok(options.out, 'usage: --out <json>')

const HARNESS_FILES = [
  'scripts/claude-session-open-bench.mjs', 'scripts/claude-session-open-harness.mjs',
  'scripts/session-open-timing.mjs', 'scripts/session-open-fixture.mjs', 'scripts/owned-app-processes.mjs',
  'scripts/hidden-electron-windows.cjs', '.agents/skills/scry-performance-climb/scripts/timing-run.mjs'
]

// Two Claude sessions of different length, both with tool output big enough that the archive
// stores the tool bodies out of line. Same spec for the baseline and the paged build.
const SESSIONS = [
  { sessionId: 'bench-medium', turns: 100, toolsPerTurn: 30, outputBytes: 8000 },
  { sessionId: 'bench-huge', turns: 150, toolsPerTurn: 30, outputBytes: 8000 }
]
const temp = mkdtempSync(join(tmpdir(), 'scry-claude-open-'))
let child
let cdp
let app

const evaluate = async expression => {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}
const wait = expression => evaluate(`(async () => {
  const deadline = performance.now() + 900000
  while (!(${expression})) {
    if (performance.now() > deadline) throw new Error('UI condition timed out: ' + ${JSON.stringify(expression)} + '\\n' + JSON.stringify({
      busy: document.querySelector('.chat-transcript')?.getAttribute('aria-busy'),
      source: document.querySelector('.chat-transcript')?.getAttribute('data-history-source'),
      turns: document.querySelectorAll('.transcript-turn').length,
      status: document.querySelector('#composer-status')?.textContent,
      body: document.body.innerText.slice(-2000)
    }))
    await new Promise(resolve => setTimeout(resolve, 16))
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
})()`)
const click = async selectorExpression => {
  const point = await evaluate(`(() => {
    const element = ${selectorExpression}
    if (!element) throw new Error('Native click target missing')
    const rect = element.getBoundingClientRect()
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    if (!element.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Native click target obscured')
    return point
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

/** Waits for the perf sample main prints when the load handler returns. */
const nextLoadSample = async mark => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const sample = app.traces.slice(mark).find(trace => trace.name === 'session_history.load')
    if (sample) return sample
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('no session_history.load perf sample for this open')
}

const readinessSource = session => `
  () => {
    const scroller = document.querySelector('.chat-transcript[aria-busy="false"][data-history-source="authoritative"]')
    const last = document.querySelector('[data-run-id=${JSON.stringify(session.lastRunId)}]')
    const input = document.querySelector('textarea')
    if (!scroller || !last || !input || input.disabled || input.readOnly) return false
    if (!(last.textContent || '').includes(${JSON.stringify(session.lastTurnText)})) return false
    const viewport = scroller.getBoundingClientRect()
    const rect = last.getBoundingClientRect()
    return rect.bottom >= viewport.top && rect.top <= viewport.bottom
  }
`

try {
  const fixture = generateClaudeFixture({ generatorRoot: options.root, tempDir: temp, sessions: SESSIONS })
  const userData = fixture.spec.userDataDir
  const home = fixture.spec.home
  const sessions = fixture.sessions
  const bootstrap = writeClaudeBootstrap(options.root, temp)
  const port = await freePort()
  app = launchClaudeApp({ root: options.root, bootstrap, userData, home, port })
  child = app.child
  cdp = await connect(port)
  await cdp.send('Runtime.enable')
  await wait(`document.querySelectorAll('button.sb-sess').length === ${sessions.length} && typeof window.scry === 'object'`)

  const samples = []
  const rounds = options.warmups + options.iterations
  for (let round = 0; round < rounds; round++) {
    for (const session of sessions) {
      const selector = `Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(session.sessionId)}))`
      const measuring = round >= options.warmups
      const traceMark = app.traceCount()
      if (measuring) {
        await evaluate(`(() => {
          window.__claudeOpenTiming = (${measureNativeSessionOpen.toString()})(
            ${selector},
            ${readinessSource(session)},
            undefined,
            ${MEASURE_DEADLINE_MS}
          )
        })()`)
      }
      await click(selector)
      await wait(`document.querySelector('.chat-transcript[aria-busy="false"][data-history-source="authoritative"]')
        && document.querySelector('[data-run-id=${JSON.stringify(session.lastRunId)}]')
        && document.querySelector('textarea') && !document.querySelector('textarea').disabled`)
      // Warm-up rounds only pay the one-time costs (content publish, index build); the timed helper
      // has a 15s in-page deadline that a cold fixture load legitimately exceeds, and a cold
      // baseline load (full 100/150-turn archive read) is minutes on a loaded host.
      const native = measuring ? await evaluate('window.__claudeOpenTiming') : { nativeOpenMs: null, selectionMs: null, handlerDelayMs: null }
      assert.equal(measuring ? native.trustedClick : true, true, 'measurement must originate from a native browser click')
      const dom = await evaluate(`(() => ({
        turns: document.querySelectorAll('.transcript-turn').length,
        source: document.querySelector('.chat-transcript').getAttribute('data-history-source'),
        hasOlderNote: Boolean(document.querySelector('.history-window-note'))
      }))()`)
      const trace = await nextLoadSample(traceMark)
      assert.equal(trace.dimensions.provider, 'claude', 'the load must be the Claude history path')
      assert.equal(trace.outcome, 'completed', 'the load must complete')
      const counters = sampleCounters(trace)
      const stages = sampleStages(trace)
      // Fixture acceptance: the transcript really was parsed, and the path is the one under test.
      assert.equal(counters.transcriptBytes, session.transcriptBytes, 'the Claude transcript must be the file the fixture wrote')
      assert.equal(counters.transcriptTurns, session.turns, 'every fixture turn must come from the transcript')
      if (options.path === 'paged') {
        assert.equal(counters.archiveIndexTurns, session.turns, 'a complete archive index must position the merge')
        assert.ok(Object.hasOwn(stages, 'archive_window'), 'the paged path must mark archive_window')
      } else {
        assert.equal(counters.archiveIndexTurns ?? 0, 0, 'the baseline must not read an archive index')
        assert.ok(!Object.hasOwn(stages, 'archive_window'), 'the baseline must not mark archive_window')
        assert.ok(counters.archiveTurns > 0, 'the baseline must read archive bodies completely')
      }
      if (measuring) {
        samples.push({
          sessionId: session.sessionId, round, openMs: native.nativeOpenMs, selectionMs: native.selectionMs,
          handlerDelayMs: native.handlerDelayMs, loadDurationMs: trace.durationMs, stages, counters,
          domTurns: dom.turns, hasOlderNote: dom.hasOlderNote
        })
      }
    }
  }

  const bySession = {}
  for (const session of sessions) {
    const own = samples.filter(sample => sample.sessionId === session.sessionId)
    const cold = own.filter(sample => sample.counters.transcriptCacheHit !== 1)
    const warm = own.filter(sample => sample.counters.transcriptCacheHit === 1)
    bySession[session.sessionId] = {
      workload: { turns: session.turns, toolsPerTurn: session.toolsPerTurn, outputBytes: session.outputBytes, transcriptBytes: session.transcriptBytes },
      all: summarise(own),
      coldTranscript: cold.length ? summarise(cold) : null,
      warmTranscript: warm.length ? summarise(warm) : null,
      archiveWindowCounts: [...new Set(own.map(sample => sample.counters.archiveWindow ?? 0))],
      archiveTurnFilesRead: [...new Set(own.map(sample => sample.counters.archiveTurnFilesRead ?? 0))],
      domTurns: [...new Set(own.map(sample => sample.domTurns))]
    }
  }
  const report = {
    kind: 'claude-session-open',
    path: options.path,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, node: process.version, loadBefore: loadavg()[0] },
    appRoot: options.root,
    buildSha256: buildSha256(options.root),
    harnessSha256: harnessSha256(root, HARNESS_FILES),
    fixture: { generator: 'scripts/claude-session-open-fixture.ts', generationMs: fixture.generationMs, sessions: fixture.sessions },
    warmups: options.warmups,
    iterations: options.iterations,
    sessions: bySession,
    samples
  }
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`SCRY_CLAUDE_OPEN=${JSON.stringify({ path: options.path, sessions: bySession })}`)
} catch (error) {
  console.error('SCRY_CLAUDE_FAILURE', JSON.stringify({
    failure: String(error).slice(0, 800), startup: startupProbe, app: inspectOwnedApp(child),
    traces: app?.traces.slice(-6).map(trace => ({ name: trace.name, outcome: trace.outcome, durationMs: trace.durationMs })),
    output: app?.output().slice(-4000)
  }))
  throw error
} finally {
  cdp?.close()
  if (child) await stopOwnedApp(child)
  rmSync(temp, { recursive: true, force: true })
}
