// Real-App behavioural acceptance for Claude history paging. Same fixture as
// claude-session-open-bench.mjs (transcript JSONL + production-written segmented archive), hidden
// window, sandbox on, every Provider disabled.
//
//   node scripts/claude-history-acceptance.mjs --root <worktree> --out <json>
//     --screenshots <dir> --expect paged|complete
//
// `--expect paged` is this branch; `--expect complete` is the baseline `a464aff`, used as the
// control for "no banner", "10-turn first page" and the end-to-end turn-text equivalence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'
import { connect, freePort, startupProbe } from './session-open-fixture.mjs'
import { generateClaudeFixture, launchClaudeApp, sampleStages, writeClaudeBootstrap } from './claude-session-open-harness.mjs'
import { createProbes } from './claude-history-acceptance-probes.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const options = { root, out: null, screenshots: null, expect: 'paged' }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
  assert.ok(Object.hasOwn(options, key), `unknown option: ${process.argv[index]}`)
  options[key] = process.argv[index + 1]
}
assert.ok(options.out && options.screenshots, 'usage: --out <json> --screenshots <dir>')
const paged = options.expect === 'paged'
// accept-dup repeats one provider turn id so the merge has to de-duplicate; the other two carry
// enough tool output that the archive stores the bodies out of line.
const SESSIONS = [
  { sessionId: 'accept-medium', turns: 100, toolsPerTurn: 30, outputBytes: 8000 },
  { sessionId: 'accept-huge', turns: 150, toolsPerTurn: 30, outputBytes: 8000 },
  { sessionId: 'accept-dup', turns: 6, toolsPerTurn: 2, outputBytes: 512, duplicateRunIdTurn: 2 }
]

const hash = value => createHash('sha256').update(value).digest('hex')
const temp = mkdtempSync(join(tmpdir(), 'scry-claude-acceptance-'))
let child
let cdp
let app
const results = []
// DOM probes live in their own module: they are renderer-facing, while this driver owns the
// fixture, the App lifecycle and the assertion report.
const { evaluate, wait, click, sessionSelector, readyExpression, capture, loadTraces, dumpTurns, loadOlderUntilStart,
  openSession, startHistoryPendingWatch, readHistoryPendingWatch } =
  createProbes({ cdp: () => cdp, app: () => app, screenshots: options.screenshots, expectValue: options.expect })

const step = async (id, name, fn) => {
  const record = { id, name, checks: [], screenshots: [], data: null }
  try {
    record.data = await fn(record)
    record.status = record.checks.some(check => !check.ok) ? 'fail' : 'pass'
  } catch (error) {
    record.status = 'error'
    record.error = String(error).slice(0, 1200)
  }
  results.push(record)
  console.log(`SCRY_ACCEPTANCE_STEP=${JSON.stringify({ id, name, status: record.status, checks: record.checks.map(c => `${c.ok ? 'ok' : 'FAIL'} ${c.name}${c.detail === undefined ? '' : `: ${c.detail}`}`) })}`)
  return record
}
const check = (record, ok, name, detail) => {
  record.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

try {
  const fixture = generateClaudeFixture({ generatorRoot: options.root, tempDir: temp, sessions: SESSIONS })
  const byId = new Map(fixture.sessions.map(session => [session.sessionId, session]))
  const medium = byId.get('accept-medium')
  const huge = byId.get('accept-huge')
  const duplicate = byId.get('accept-dup')
  assert.ok(medium && huge && duplicate, 'the acceptance fixture must hold accept-medium, accept-huge and accept-dup')
  const userData = fixture.spec.userDataDir
  const home = fixture.spec.home
  // The fixture keeps its generating cwd: archive segments embed and re-validate that path.
  const workspace = fixture.spec.cwd
  const bootstrap = writeClaudeBootstrap(options.root, temp)
  const port = await freePort()
  app = launchClaudeApp({ root: options.root, bootstrap, userData, home, port })
  child = app.child
  cdp = await connect(port)
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await wait(`document.querySelectorAll('button.sb-sess').length === ${fixture.sessions.length} && typeof window.scry === 'object'`)

  // 1. No history banner at any duration; the composer cannot send while history is pending.
  await step('T4-1', 'banner absent and sending locked during a slow read', async record => {
    await startHistoryPendingWatch()
    const startMark = app.traceCount()
    // Typing is allowed (a draft must survive the read); sending is what pending authority blocks.
    await click(`document.querySelector('textarea')`)
    for (const key of ['a', 'b']) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
    }
    let typingMethod = await evaluate(`document.querySelector('textarea')?.value ? 'native-keys' : null`)
    if (!typingMethod) {
      // Fall back to the prototype setter: React's controlled input still observes the change.
      typingMethod = await evaluate(`(() => {
        const textarea = document.querySelector('textarea')
        if (!textarea) return null
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(textarea, 'draft typed while history loads')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        return textarea.value ? 'value-setter' : null
      })()`)
    }
    const typedDraft = await evaluate(`document.querySelector('textarea')?.value ?? null`)
    const clickedSession = click(sessionSelector(huge.sessionId))
    await evaluate(`(async () => {
      const deadline = performance.now() + 20000
      while (performance.now() < deadline) {
        const scroller = document.querySelector('.chat-transcript')
        if (scroller?.getAttribute('data-history-source') === 'preview' || scroller?.getAttribute('aria-busy') === 'true') return true
        await new Promise(resolve => setTimeout(resolve, 16))
      }
      return false
    })()`)
    const pendingAt = await evaluate(`(() => ({
      source: document.querySelector('.chat-transcript')?.getAttribute('data-history-source') ?? null,
      busy: document.querySelector('.chat-transcript')?.getAttribute('aria-busy') ?? null,
      turns: document.querySelectorAll('.transcript-turn').length,
      draft: document.querySelector('textarea')?.value ?? null,
      sendDisabled: document.querySelector('button.send')?.disabled ?? null,
      sendStatus: document.querySelector('#composer-status')?.textContent ?? null
    }))()`)
    await click(`document.querySelector('button.send')`)
    await new Promise(resolve => setTimeout(resolve, 500))
    const afterSend = await evaluate(`(() => ({
      source: document.querySelector('.chat-transcript')?.getAttribute('data-history-source') ?? null,
      turns: document.querySelectorAll('.transcript-turn').length,
      draft: document.querySelector('textarea')?.value ?? null,
      status: document.querySelector('#composer-status')?.textContent ?? null
    }))()`)
    // A send that was accepted would start a run; the pending read must not let one through.
    const sends = loadTraces('ipc.agent:startRun', startMark).length +
      app.traces.slice(startMark).filter(trace => trace.name === 'ipc.agent:start').length
    await clickedSession
    await wait(readyExpression(huge))
    const readyAt = await evaluate(`(() => ({
      source: document.querySelector('.chat-transcript')?.getAttribute('data-history-source') ?? null,
      draft: document.querySelector('textarea')?.value ?? null,
      sendDisabled: document.querySelector('button.send')?.disabled ?? null,
      agentLocked: document.querySelector('.composer-action-controls button')?.disabled ?? null
    }))()`)
    const timeline = await readHistoryPendingWatch()
    record.screenshots.push(await capture('t4-01-locked-composer-huge-session'))
    check(record, timeline.samples > 0, 'loading timeline captured', `${timeline.samples} samples, ${timeline.pending} pending`)
    if (paged) {
      check(record, timeline.bannerSeen === false, 'no history banner during a slow read')
      check(record, timeline.pending > 0, 'the slow read actually reached the pending state',
        `${timeline.pending} pending samples; pending source=${pendingAt.source} busy=${pendingAt.busy}`)
      check(record, Boolean(typingMethod), 'the composer accepts input while history loads',
        `method=${typingMethod}, value after typing=${JSON.stringify(typedDraft)}`)
      check(record, pendingAt.sendDisabled === true, 'the send control is disabled while history is pending', `disabled=${pendingAt.sendDisabled}`)
      check(record, sends === 0, 'sending is refused while history is pending', `start traces=${sends}`)
      check(record, afterSend.turns === pendingAt.turns && afterSend.draft === pendingAt.draft,
        'the refused send changed no turn and kept the draft', `turns ${pendingAt.turns}->${afterSend.turns}`)
    } else {
      // Control for the detector: the baseline still shows the timed banner.
      check(record, true, 'baseline control recorded (banner expected)', `bannerSeen=${timeline.bannerSeen}, pending=${timeline.pending}`)
    }
    check(record, readyAt.agentLocked === false, 'the same controls unlock once the page is authoritative', `agentLocked=${readyAt.agentLocked}`)
    return { ...timeline, typingMethod, typedDraft, pendingAt, readyAt, afterSend, sends }
  })

  // 2. First page is 10 turns and offers the older-range control.
  await step('T4-2', 'first page holds ten turns and offers older turns', async record => {
    const openMs = await openSession(medium)
    const page = await evaluate(`(() => ({
      turns: document.querySelectorAll('.transcript-turn').length,
      hasOlderNote: Boolean(document.querySelector('.history-window-note')),
      noteText: document.querySelector('.history-window-note')?.textContent ?? null,
      firstRunId: document.querySelector('.transcript-turn')?.dataset.runId ?? null
    }))()`)
    record.screenshots.push(await capture('t4-02-first-page'))
    check(record, page.hasOlderNote, 'an older-turns control is offered')
    if (paged) check(record, page.turns === 10, 'first page holds 10 turns', `turns=${page.turns}`)
    else check(record, true, 'baseline page size recorded', `turns=${page.turns}`)
    return { openMs, ...page }
  })

  // 3. Scrolling to the start equals the complete merge (compared with the baseline dump).
  await step('T4-3', 'walking back to the first turn', async record => {
    await openSession(medium)
    const firstPageTurns = await evaluate(`document.querySelectorAll('.transcript-turn').length`)
    const walked = await loadOlderUntilStart()
    const dump = await dumpTurns()
    record.screenshots.push(await capture('t4-03-all-turns-loaded'))
    const addedCounts = walked.pages.map(page => page.added)
    check(record, dump.mounted === dump.total, 'every turn was mounted and read', `${dump.mounted}/${dump.total}`)
    check(record, walked.pages.length > 0, 'older pages were loaded', `${walked.pages.length} pages: ${addedCounts.join(',')}`)
    check(record, walked.totalTurns === medium.turns, 'all fixture turns are reachable', `${walked.totalTurns}/${medium.turns}`)
    if (paged) check(record, addedCounts.slice(0, -1).every(added => added === 20), 'transcript older pages hold 20 turns', addedCounts.join(','))
    if (paged) check(record, firstPageTurns === 10, 'the walk started from a 10-turn page', `turns=${firstPageTurns}`)
    check(record, !walked.stopped, 'the walk was not stopped by an unusable control', walked.stopped ?? '')
    return { firstPageTurns, pages: walked.pages, totalTurns: walked.totalTurns, stopped: walked.stopped ?? null,
      diagnostics: walked.diagnostics ?? null, tracesInWindow: walked.tracesInWindow ?? null, dump }
  })

  // 4. Switching sessions while an older page is in flight cancels it silently.
  await step('T4-4', 'older-page request cancelled by a session switch', async record => {
    // Retry so the switch really happens while the older page is in flight.
    let inFlight = false
    for (let attempt = 0; attempt < 3 && !inFlight; attempt++) {
      await openSession(attempt === 0 ? medium : duplicate)
      if (attempt > 0) await openSession(medium)
      await click(`document.querySelector('.history-window-more')`)
      inFlight = await evaluate(`(async () => {
        const deadline = performance.now() + 1000
        while (performance.now() < deadline) {
          if (document.querySelector('.history-window-note')?.getAttribute('aria-busy') === 'true') return true
          await new Promise(resolve => setTimeout(resolve, 2))
        }
        return false
      })()`)
      if (inFlight) break
    }
    await openSession(duplicate)
    const after = await evaluate(`(() => ({
      status: document.querySelector('#composer-status')?.textContent ?? null,
      statusIsError: Boolean(document.querySelector('#composer-status.is-error')),
      turns: document.querySelectorAll('.transcript-turn').length,
      foreign: Array.from(document.querySelectorAll('.transcript-turn[data-run-id]')).filter(node => !node.dataset.runId.startsWith(${JSON.stringify(duplicate.sessionId)})).length
    }))()`)
    record.screenshots.push(await capture('t4-04-switch-cancelled'))
    check(record, inFlight, 'the older page was in flight when the session switched')
    check(record, after.statusIsError === false, 'no error surfaced for the cancelled page', after.status ?? '')
    check(record, after.foreign === 0, 'no turn from the previous session leaked in', `foreign=${after.foreign}`)
    check(record, after.turns > 0, 'the new session rendered its own page', `turns=${after.turns}`)
    return { ...after, inFlight }
  })

  // 6. Duplicate runId across two segments falls back to the complete read (same count as baseline).
  await step('T4-6', 'duplicate runId does not add a turn', async record => {
    const mark = app.traceCount()
    await openSession(duplicate)
    const page = await evaluate(`(() => {
      const runIds = Array.from(document.querySelectorAll('.transcript-turn')).map(node => node.dataset.runId)
      return { turns: runIds.length, unique: new Set(runIds).size, runIds }
    })()`)
    const trace = loadTraces('session_history.load', mark).at(-1)
    record.screenshots.push(await capture('t4-06-duplicate-runid'))
    check(record, page.turns === duplicate.turns, 'turn count equals the fixture', `${page.turns}/${duplicate.turns}`)
    check(record, page.unique === page.turns, 'no turn is rendered twice')
    return { ...page, counters: trace?.checkpoints?.flatMap(checkpoint => checkpoint.counters ? [checkpoint.counters] : []) ?? [] }
  })

  // 5. A damaged not-yet-loaded segment surfaces through the composer, and reopening works.
  await step('T4-5', 'damaged older segment is reported, then the session reopens', async record => {
    await openSession(medium)
    const dir = join(userData, 'trace-archive-turns-v1', 'claude', `cwd-${hash(workspace)}`, `sid-${hash(medium.sessionId)}`)
    const victimRunId = `${medium.sessionId}-run-${medium.turns - 25}`
    let victim = null
    for (const name of readdirSync(dir)) {
      if (!/^turn-[a-f0-9]{64}\.json$/.test(name)) continue
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (parsed.turns?.[0]?.runId === victimRunId) { victim = join(dir, name); break }
    }
    assert.ok(victim, `no segment file for ${victimRunId}`)
    unlinkSync(victim)
    await click(`document.querySelector('.history-window-more')`)
    await wait(`document.querySelector('#composer-status.is-error') != null`)
    const failure = await evaluate(`(() => ({
      status: document.querySelector('#composer-status')?.textContent ?? null,
      role: document.querySelector('#composer-status')?.getAttribute('role') ?? null
    }))()`)
    record.screenshots.push(await capture('t4-05-older-page-failure'))
    check(record, /无法加载更早轮次/.test(failure.status ?? ''), 'the failure is reported in the composer', failure.status ?? '')
    // Reopening must still work; the perf trace says whether it stayed paged.
    const mark = app.traceCount()
    await openSession(medium)
    const trace = loadTraces('session_history.load', mark).at(-1)
    const stages = trace ? sampleStages(trace) : null
    const counters = trace?.checkpoints?.flatMap(checkpoint => checkpoint.counters ? [checkpoint.counters] : []) ?? []
    const turns = await evaluate(`document.querySelectorAll('.transcript-turn').length`)
    record.screenshots.push(await capture('t4-05-reopened'))
    check(record, trace?.outcome === 'completed', 'reopening the session still completes')
    check(record, turns > 0, 'reopened session shows turns', `turns=${turns}`)
    return {
      victimRunId, failure, reopen: { outcome: trace?.outcome ?? null, stages, counters, turns },
      fellBackToComplete: !Object.hasOwn(stages ?? {}, 'archive_window')
    }
  })

  const report = {
    kind: 'claude-history-acceptance',
    expect: options.expect,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, node: process.version, load: loadavg()[0] },
    appRoot: root,
    fixture: { sessions: fixture.sessions },
    results
  }
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
  const failed = results.filter(result => result.status !== 'pass')
  console.log(`SCRY_ACCEPTANCE=${JSON.stringify({ expect: options.expect, status: failed.length ? 'fail' : 'pass', steps: results.map(r => `${r.id}:${r.status}`) })}`)
  assert.equal(failed.length, 0, `acceptance steps failed: ${failed.map(result => result.id).join(',')}`)
} catch (error) {
  console.error('SCRY_ACCEPTANCE_FAILURE', JSON.stringify({
    failure: String(error).slice(0, 1200), startup: startupProbe, app: inspectOwnedApp(child),
    traces: app?.traces.slice(-8).map(trace => ({ name: trace.name, outcome: trace.outcome, durationMs: trace.durationMs })),
    output: app?.output().slice(-4000)
  }))
  throw error
} finally {
  cdp?.close()
  if (child) await stopOwnedApp(child)
  rmSync(temp, { recursive: true, force: true })
}
