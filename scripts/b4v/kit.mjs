// Shared scenario plumbing: one fixture per scenario, isolation steps first, cleanup and
// evidence always, and the renderer expressions every scenario uses. A scenario body only
// says what it does and what it expects.
import { randomUUID } from 'node:crypto'
import { closeAllApps, openApp, sleep, attempt } from './app.mjs'
import {
  collectLiveIsolation, createFixture, daemonLogPath, daemonLogTail, disposeFixture, fixtureLeftovers,
  own, reapOwned, stopFixtureDaemon
} from './fixture.mjs'
import { readIdentity, verifyHolder } from './process-identity.mjs'
import { readLedger, runIdForPrompt, runIdForScryRun, runSummary } from './ledger.mjs'
import { createScenario, finishScenario, recordStep } from './report.mjs'

export class Abort extends Error {}

export function isolationPlan(mode) {
  return [
    { id: 'isolation-static', expected: 'userData, HOME and workspace sit in a fresh root under /tmp, outside the real HOME and real Scry userData; the daemon socket path fits the platform limit' },
    mode === 'daemon'
      ? { id: 'isolation-live', expected: 'before acting: scry.db exists in the temp userData; daemon.lock in <temp>/userData/daemon has a verified live holder; scry-userdata.lock is held by that same daemon (role daemon); the daemon environment names the temp userData' }
      : { id: 'isolation-live', expected: 'before acting: scry.db exists in the temp userData; no daemon.lock; scry-userdata.lock is held by this App (role app)' }
  ]
}

export async function runScenario(ctx, { id, title, mode, label, plan }, body) {
  const scenario = createScenario(ctx.report, { id, title, mode, plan: [...isolationPlan(mode), ...plan] })
  if (ctx.blocked) {
    // A failed required preflight: every step is reported as not run, with that reason.
    finishScenario(scenario, ctx.blocked)
    ctx.save()
    return scenario
  }
  let fixture
  let abort
  try {
    fixture = createFixture(label)
    ctx.active.add(fixture)
    scenario.evidence.tempRoot = fixture.tempRoot
    scenario.evidence.logs = fixture.logs
    scenario.evidence.daemonLog = daemonLogPath(fixture)
    recordStep(scenario, { id: 'isolation-static', actual: fixture.staticIsolation.checks, pass: fixture.staticIsolation.ok })
    if (!fixture.staticIsolation.ok) throw new Abort('static isolation failed; nothing was launched')
    await body({ scenario, fixture })
  } catch (error) {
    abort = error instanceof Abort ? error.message : `unexpected error: ${error?.message ?? error}`
    if (!(error instanceof Abort)) scenario.evidence.error = String(error?.stack ?? error).slice(0, 4_000)
  } finally {
    if (fixture) {
      const cleanup = {}
      try {
        cleanup.apps = await closeAllApps(fixture)
        cleanup.daemon = await stopFixtureDaemon(fixture)
        cleanup.owned = await reapOwned(fixture)
        cleanup.leftovers = fixtureLeftovers(fixture)
        cleanup.daemonLogTail = daemonLogTail(fixture)
      } catch (error) {
        cleanup.error = String(error?.message ?? error)
      }
      scenario.evidence.cleanup = cleanup
    }
    const status = finishScenario(scenario, abort)
    if (fixture) {
      // A failed or partial scenario keeps its directory: the logs and the ledger are the evidence.
      const keep = ctx.options.keep || status === 'fail' || status === 'partial' || Boolean(scenario.evidence.cleanup?.error)
      scenario.evidence.disposed = disposeFixture(fixture, { keep })
      ctx.active.delete(fixture)
    }
    ctx.save()
  }
  return scenario
}

/** Open an App and, the first time in a scenario, record the live isolation step. */
export async function openChecked(ctx, scenario, fixture, { mode, label, isolation = true, env, waitReady = true }) {
  const app = await openApp({ root: ctx.root, fixture, mode, label, env, waitReady })
  scenario.evidence.apps = [...(scenario.evidence.apps ?? []), { label, pid: app.pid, log: app.logPath, ready: app.ready ?? null }]
  if (waitReady && !app.ready?.ok) {
    if (isolation) recordStep(scenario, { id: 'isolation-live', actual: { appReady: app.ready }, pass: false })
    throw new Abort(`App ${label} never became ready: ${app.ready?.error ?? 'unknown'}`)
  }
  if (isolation) {
    const live = await waitForLiveIsolation(fixture, { mode, appPid: app.pid })
    recordStep(scenario, { id: 'isolation-live', actual: live.checks, pass: live.ok })
    if (!live.ok) throw new Abort('live isolation failed; the scenario did not act')
  }
  await app.evaluate(TRACE_COLLECTOR)
  // Not fatal here: an App that refuses its daemon (version mismatch) may refuse this too,
  // and that refusal is what such a scenario observes next.
  app.setCwd = await attempt(app, `window.scry.setCwd(${JSON.stringify(fixture.workspace)})`)
  return app
}

// scry.db and the locks appear shortly after the first answered call; poll, bounded.
export async function waitForLiveIsolation(fixture, { mode, appPid, timeoutMs = 15_000 }) {
  const deadline = Date.now() + timeoutMs
  let live = collectLiveIsolation(fixture, { mode, appPid })
  while (!live.ok && Date.now() < deadline) {
    await sleep(100)
    live = collectLiveIsolation(fixture, { mode, appPid })
  }
  return live
}

export const nonce = () => randomUUID().slice(0, 8)
export const HOLD_PROMPT = (tag) => `native composer b4v hold ${tag} ${nonce()}`
export const COMPLETE_PROMPT = (tag) => `native composer complete b4v ${tag} ${nonce()}`
export const PACED_PROMPT = 'performance paced stream'
export const SEEDED_QUESTION_PROMPT = 'concurrency trace live'

// Per-window trace collector: text, result and error per run id, exactly as the window
// receives them. Installed once per App; the start receipt's runId keys it.
export const TRACE_COLLECTOR = `(() => {
  if (window.__b4v) return true
  window.__b4v = { runs: {} }
  const rec = (runId) => (window.__b4v.runs[runId] ??= { text: 0, result: null, errors: [] })
  window.scry.onTrace((events) => {
    for (const event of events) {
      if (!event || typeof event.runId !== 'string') continue
      const run = rec(event.runId)
      if (event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta')) run.text += 1
      if (event.kind === 'harness' && event.stage === 'result') run.result = { isError: event.isError === true, text: String(event.text ?? '').slice(0, 300) }
      if (event.isError === true || event.kind === 'error' || event.stage === 'error') run.errors.push(String(event.text ?? event.stage).slice(0, 300))
    }
  })
  return true
})()`

/** Start through the shipped preload API; the commandId makes the start idempotent. */
export async function startRun(app, { prompt, cwd, extra = {} }) {
  const commandId = randomUUID()
  const startedAt = Date.now()
  const started = await attempt(app, `window.scry.start(${JSON.stringify({ prompt, providerId: 'codex', cwd, commandId, ...extra })})
    .then((receipt) => ({ ok: true, runId: String(receipt.runId) }), (error) => ({ ok: false, error: String(error && error.message || error) }))`)
  if (!started.ok) return { ok: false, error: started.error, commandId, prompt, startedAt }
  return { ...started.value, commandId, prompt, startedAt }
}

/** What the window shows for one run; `done: null` means the window cannot tell. */
export function observeExpression(runId) {
  return `(async () => {
    const runId = ${JSON.stringify(runId)}
    const trace = window.__b4v && window.__b4v.runs[runId] || null
    const runs = await window.scry.activeRuns().catch(() => [])
    const active = runs.find((run) => run.runId === runId) || null
    const focused = await window.scry.focusedRunSnapshot().catch(() => null)
    const view = active || (focused && focused.runId === runId ? focused : null)
    const textItems = view ? view.items.filter((item) => item.kind === 'model' && (item.stage === 'text' || item.stage === 'text_delta')).length : 0
    return {
      listed: Boolean(active),
      done: view ? view.done === true : (trace && trace.result ? true : null),
      error: (view && view.error) || (trace && trace.result && trace.result.isError ? trace.result.text : (trace && trace.errors[0]) || null),
      output: textItems > 0 || Boolean(trace && trace.text > 0),
      stopState: view && view.stopState || null,
      sessionId: view && (view.externalSessionId || view.sessionId) || null,
      pendingQuestions: view && view.pendingQuestions ? view.pendingQuestions.length : 0
    }
  })()`
}

export async function observeRun(app, runId) {
  const observed = await attempt(app, observeExpression(runId))
  return observed.ok ? observed.value : { done: null, error: null, output: false, observeError: observed.error }
}

export async function waitRun(app, runId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = await observeRun(app, runId)
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(100)
    last = await observeRun(app, runId)
  }
  return { ok: predicate(last), value: last }
}

/** A real shell through the preload API; its pty identity is recorded for later checks and cleanup. */
export async function startTerminal(app, fixture, scopeId) {
  const started = await attempt(app, `window.scry.terminalStart(${JSON.stringify({ cwd: fixture.workspace, scopeId, cols: 80, rows: 24 })})
    .then(async (session) => {
      await window.scry.terminalReady(session.id, session.ownershipEpoch)
      return { id: session.id, pid: session.pid, epoch: session.ownershipEpoch }
    })`)
  if (!started.ok) return { ok: false, error: started.error }
  const identity = readIdentity(Number(started.value.pid))
  if (identity) own(fixture, identity, 'pty')
  return { ok: Boolean(identity), ...started.value, identity: identity ?? null }
}

export function stillAlive(identity) {
  return Boolean(identity) && verifyHolder(identity, readIdentity(identity.pid)) === 'verified'
}

/**
 * The ledger's view of the run a start produced, polled until `predicate` holds. The
 * link is the ledger's own `bound` event for the App's run id; a start that returned no
 * run id is found by its (nonce-carrying) prompt, first intent at or after the start.
 */
export async function waitLedger(fixture, started, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let summary = null
  let ledger
  let linkedBy = null
  do {
    ledger = readLedger(fixture.userDataDir)
    let runId = started.ok ? runIdForScryRun(ledger, started.runId) : null
    linkedBy = runId ? 'bound-event' : null
    // A window that adopted the run from the daemon may already name it by the ledger id.
    if (!runId && started.ok && runSummary(ledger, started.runId).known) {
      runId = started.runId
      linkedBy = 'ledger-id'
    }
    if (!runId) {
      runId = runIdForPrompt(ledger, started.prompt, started.startedAt)
      linkedBy = runId ? 'prompt' : null
    }
    summary = runId ? runSummary(ledger, runId) : null
    if (summary && predicate(summary)) return { ok: true, summary, linkedBy, path: ledger.path ?? null }
    await sleep(100)
  } while (Date.now() < deadline)
  return { ok: false, summary, linkedBy, path: ledger?.path ?? null, ledgerStatus: ledger?.status }
}
