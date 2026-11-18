// Read-only view of the daemon's session ledger, the authority on a run's lifecycle.
// The scripts read the file the daemon writes instead of asking the App, so "the run
// settled" is the daemon's own record, not the window's impression of it.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TERMINAL = new Map([['run_settled', 'settled'], ['run_failed', 'failed'], ['run_cancelled', 'cancelled']])

/** The remote host keeps its ledger under userData/remote; older notes name userData/daemon. */
export function ledgerDirectories(userDataDir) {
  return [join(userDataDir, 'remote', 'ledger'), join(userDataDir, 'daemon', 'ledger')]
}

export function parseLedgerLog(text) {
  const events = []
  let torn = 0
  for (const line of String(text).split('\n')) {
    if (line.length === 0) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event.runId === 'string' && typeof event.kind === 'string') events.push(event)
      else torn += 1
    } catch { torn += 1 }
  }
  return { events, torn }
}

export function readLedger(userDataDir, { readFile = (path) => readFileSync(path, 'utf8'), exists = existsSync } = {}) {
  for (const directory of ledgerDirectories(userDataDir)) {
    const log = join(directory, 'session-ledger.log')
    const snapshotPath = join(directory, 'session-ledger.snapshot.json')
    if (!exists(log) && !exists(snapshotPath)) continue
    const parsed = exists(log) ? parseLedgerLog(readFile(log)) : { events: [], torn: 0 }
    let snapshot = null
    if (exists(snapshotPath)) {
      // On disk the snapshot is wrapped: { version, checksum, snapshot: { runs, retainedEvents } }.
      try { snapshot = JSON.parse(readFile(snapshotPath))?.snapshot ?? { unreadable: true } } catch { snapshot = { unreadable: true } }
    }
    return { status: 'available', path: log, snapshotPath, events: mergeEvents(snapshot?.retainedEvents, parsed.events), torn: parsed.torn, snapshot }
  }
  return { status: 'missing', paths: ledgerDirectories(userDataDir), events: [], torn: 0, snapshot: null }
}

// Compaction keeps a bounded tail inside the snapshot; the log may repeat some of it.
export function mergeEvents(retained, logged) {
  const bySeq = new Map()
  const unsequenced = []
  for (const event of [...(Array.isArray(retained) ? retained : []), ...logged]) {
    if (Number.isSafeInteger(event?.seq)) bySeq.set(event.seq, event)
    else if (event) unsequenced.push(event)
  }
  return [...[...bySeq.values()].sort((left, right) => left.seq - right.seq), ...unsequenced]
}

function snapshotRun(snapshot, runId) {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : []
  return runs.find((run) => run?.runId === runId)
}

/**
 * One run as the ledger knows it. `dispatches` counts `run_dispatched` events in the
 * visible tail; after compaction the snapshot's lifecycle is the fallback and the count
 * is reported as a lower bound (`dispatchCountExact: false`).
 */
export function runSummary(ledger, runId) {
  const events = ledger.events.filter((event) => event.runId === runId)
  const kinds = events.map((event) => event.kind)
  const terminalEvent = events.find((event) => TERMINAL.has(event.kind))
  const fromSnapshot = snapshotRun(ledger.snapshot, runId)
  const intentInTail = kinds.includes('intent_recorded')
  return {
    runId,
    known: events.length > 0 || Boolean(fromSnapshot),
    kinds,
    intentId: events.find((event) => event.intentId)?.intentId ?? fromSnapshot?.intentId ?? null,
    dispatches: kinds.filter((kind) => kind === 'run_dispatched').length,
    dispatchCountExact: intentInTail,
    dispatchedAt: events.find((event) => event.kind === 'run_dispatched')?.at ?? null,
    terminal: terminalEvent ? TERMINAL.get(terminalEvent.kind) : (['settled', 'failed', 'cancelled'].includes(fromSnapshot?.lifecycle) ? fromSnapshot.lifecycle : null),
    terminalAt: terminalEvent?.at ?? null,
    terminalDetail: typeof terminalEvent?.detail === 'string' ? terminalEvent.detail : null,
    lifecycle: fromSnapshot?.lifecycle ?? null
  }
}

export function failedHostRestarted(summary) {
  return summary.terminal === 'failed' && typeof summary.terminalDetail === 'string' && summary.terminalDetail.startsWith('host_restarted')
}

/** Intents whose routing detail carries this exact prompt (prompts here carry a nonce). */
export function intentsForPrompt(ledger, prompt) {
  return ledger.events.filter((event) => event.kind === 'intent_recorded' && typeof event.detail === 'string' && (() => {
    try { return JSON.parse(event.detail)?.prompt === prompt } catch { return event.detail.includes(prompt) }
  })())
}

/**
 * The App's run id is the bound runtime id the trace carries (`scryRunId`); the ledger
 * keys the same run by its own id and records the binding as a `run_progress` event
 * `{ event: 'bound', ledgerRunId, scryRunId }`. That event is the exact link.
 */
export function runIdForScryRun(ledger, scryRunId) {
  if (typeof scryRunId !== 'string' || scryRunId.length === 0) return null
  for (const event of ledger.events) {
    if (event.kind !== 'run_progress' || typeof event.detail !== 'string') continue
    let detail
    try { detail = JSON.parse(event.detail) } catch { continue }
    if (detail?.event === 'bound' && detail.scryRunId === scryRunId) return detail.ledgerRunId ?? event.runId
  }
  return null
}

/**
 * Fallback for a start that never returned a run id (refused, or reply lost): the first
 * intent carrying exactly this prompt recorded at or after the start. Scenarios start
 * runs one after another, so the first one after the stamp is this start's.
 */
export function runIdForPrompt(ledger, prompt, notBefore, skewMs = 1_000) {
  const event = intentsForPrompt(ledger, prompt).find((candidate) => typeof candidate.at !== 'number' || candidate.at >= notBefore - skewMs)
  return event?.runId ?? null
}

/**
 * Device intent ids are scoped by the device certificate inside the daemon
 * (scopedIntentId), so a client's own id only matches a ledger intentId when the caller
 * already holds the scoped value.
 */
export function runIdForIntent(ledger, intentId) {
  const event = ledger.events.find((candidate) => candidate.intentId === intentId && typeof candidate.runId === 'string')
  if (event) return event.runId
  const runs = Array.isArray(ledger.snapshot?.runs) ? ledger.snapshot.runs : []
  return runs.find((run) => run?.intentId === intentId)?.runId ?? null
}
