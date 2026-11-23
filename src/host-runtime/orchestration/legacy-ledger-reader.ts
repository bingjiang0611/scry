import { h1DetailDigest } from './authority-dispatch'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LedgerEvent, LedgerSnapshot, LedgerSnapshotRun } from '../../main/remote/session-ledger'
import type { EventSink } from './event-sink'

export interface LegacyLedgerPlan {
  readonly currentLedgerSeq: number
  readonly lastSeq: number
  readonly unimportedRuns: readonly LegacyRunState[]
  readonly openRuns: readonly LegacyRunState[]
  readonly runsByLedgerId: ReadonlyMap<string, LegacyRunState>
}

export interface LegacyRunState {
  ledgerRunId: string
  intentId: string
  intentSeq: number
  intentAt: number
  detail?: string
  intentDigest?: string
  lifecycle: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled'
  lastSeq: number
  terminalAt?: number
  terminalDetail?: string
}

const STREAM_CHUNK_SIZE = 500

const LEGACY_LEDGER_WORKER_SOURCE = `
'use strict';
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const ledgerDir = workerData.ledgerDir;
const minSeqExclusive = typeof workerData.minSeqExclusive === 'number' ? workerData.minSeqExclusive : -1;
const chunkSize = typeof workerData.chunkSize === 'number' && workerData.chunkSize > 0 ? workerData.chunkSize : 500;
const includeAllRuns = Boolean(workerData.includeAllRuns);
const runs = new Map();
let lastSeq = 0;

const snapshotPath = join(ledgerDir, 'session-ledger.snapshot.json');
if (existsSync(snapshotPath)) {
  try {
    const env = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const snap = env && env.snapshot;
    if (snap && Array.isArray(snap.runs)) {
      lastSeq = Math.max(lastSeq, snap.lastSeq || 0);
      for (const r of snap.runs) {
        runs.set(r.runId, {
          ledgerRunId: r.runId,
          intentId: r.intentId,
          intentSeq: r.intentSeq,
          intentAt: r.intentAt,
          detail: r.intentDetail,
          intentDigest: r.intentDigest,
          lifecycle: r.lifecycle,
          lastSeq: snap.lastSeq
        });
      }
    }
  } catch {}
}

const logPath = join(ledgerDir, 'session-ledger.log');
if (existsSync(logPath)) {
  const raw = readFileSync(logPath, 'utf8');
  for (const line of raw.split('\\n')) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof evt.seq !== 'number' || evt.seq <= 0) continue;
    lastSeq = Math.max(lastSeq, evt.seq);
    if (evt.kind === 'intent_recorded') {
      runs.set(evt.runId, {
        ledgerRunId: evt.runId,
        intentId: evt.intentId || ('legacy-intent:' + evt.runId),
        intentSeq: evt.seq,
        intentAt: evt.at,
        detail: evt.detail,
        intentDigest: createHash('sha256').update(evt.detail === undefined ? 'undefined' : 'string\\0' + evt.detail).digest('hex'),
        lifecycle: 'recorded',
        lastSeq: evt.seq
      });
    } else {
      const existing = runs.get(evt.runId);
      if (!existing) continue;
      existing.lastSeq = Math.max(existing.lastSeq, evt.seq);
      if (evt.kind === 'run_dispatched') existing.lifecycle = 'dispatched';
      else if (evt.kind === 'run_settled') {
        existing.lifecycle = 'settled';
        existing.terminalAt = evt.at;
      } else if (evt.kind === 'run_failed') {
        existing.lifecycle = 'failed';
        existing.terminalAt = evt.at;
        existing.terminalDetail = evt.detail;
      } else if (evt.kind === 'run_cancelled') {
        existing.lifecycle = 'cancelled';
        existing.terminalAt = evt.at;
        existing.terminalDetail = evt.detail;
      }
    }
  }
}

// Perform filtering and sorting inside the worker thread so main thread never sorts 100k items.
const selected = [];
if (includeAllRuns) {
  for (const run of runs.values()) selected.push(run);
} else if (lastSeq > minSeqExclusive) {
  for (const run of runs.values()) {
    if (run.lastSeq > minSeqExclusive) selected.push(run);
  }
}
selected.sort((a, b) => a.intentSeq - b.intentSeq);

let offset = 0;
function sendNext() {
  if (offset < selected.length) {
    const slice = selected.slice(offset, offset + chunkSize);
    offset += slice.length;
    parentPort.postMessage({ type: 'chunk', runs: slice });
  } else {
    parentPort.postMessage({ type: 'done', lastSeq });
  }
}

parentPort.on('message', (cmd) => {
  if (cmd === 'next') sendNext();
});
sendNext();
`

export interface StreamedLegacyLedgerResult {
  lastSeq: number
  sortedRuns: LegacyRunState[]
  runs: Map<string, LegacyRunState>
}

export function readLegacyLedgerStreamedAsync(
  ledgerDir: string,
  options?: { minSeqExclusive?: number; includeAllRuns?: boolean; chunkSize?: number }
): Promise<StreamedLegacyLedgerResult> {
  if (!existsSync(ledgerDir)) {
    return Promise.resolve({ lastSeq: 0, sortedRuns: [], runs: new Map() })
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(LEGACY_LEDGER_WORKER_SOURCE, {
      eval: true,
      workerData: {
        ledgerDir,
        minSeqExclusive: options?.minSeqExclusive ?? -1,
        includeAllRuns: options?.includeAllRuns ?? false,
        chunkSize: options?.chunkSize ?? STREAM_CHUNK_SIZE
      }
    })
    const sortedRuns: LegacyRunState[] = []
    const runs = new Map<string, LegacyRunState>()
    let settled = false
    const finish = (cb: () => void): void => {
      if (settled) return
      settled = true
      void worker.terminate()
      cb()
    }
    worker.on('message', (msg: { type: 'chunk'; runs: LegacyRunState[] } | { type: 'done'; lastSeq: number }) => {
      if (settled) return
      if (msg.type === 'chunk') {
        for (const run of msg.runs) {
          sortedRuns.push(run)
          runs.set(run.ledgerRunId, run)
        }
        setImmediate(() => {
          if (!settled) worker.postMessage('next')
        })
        return
      }
      finish(() => resolve({ lastSeq: msg.lastSeq, sortedRuns, runs }))
    })
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`legacy ledger worker exited unexpectedly with code ${code}`)))
    )
  })
}

export async function readLegacyLedgerAsync(
  ledgerDir: string
): Promise<{ lastSeq: number; runs: Map<string, LegacyRunState> }> {
  const streamed = await readLegacyLedgerStreamedAsync(ledgerDir, { includeAllRuns: true })
  return { lastSeq: streamed.lastSeq, runs: streamed.runs }
}

export function readLegacyLedgerReadOnly(ledgerDir: string): { lastSeq: number; runs: Map<string, LegacyRunState> } {
  const runs = new Map<string, LegacyRunState>()
  let lastSeq = 0
  const snapshotPath = join(ledgerDir, 'session-ledger.snapshot.json')
  if (existsSync(snapshotPath)) {
    try {
      const env = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { snapshot?: LedgerSnapshot }
      const snap = env?.snapshot
      if (snap && Array.isArray(snap.runs)) {
        lastSeq = Math.max(lastSeq, snap.lastSeq ?? 0)
        for (const r of snap.runs as LedgerSnapshotRun[]) {
          runs.set(r.runId, {
            ledgerRunId: r.runId,
            intentId: r.intentId,
            intentSeq: r.intentSeq,
            intentAt: r.intentAt,
            detail: r.intentDetail,
          intentDigest: r.intentDigest,
            lifecycle: r.lifecycle,
            lastSeq: snap.lastSeq
          })
        }
      }
    } catch {
      // Unreadable snapshot is skipped; log tail still checked below.
    }
  }

  const logPath = join(ledgerDir, 'session-ledger.log')
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let evt: LedgerEvent
      try {
        evt = JSON.parse(line) as LedgerEvent
      } catch {
        continue
      }
      if (typeof evt.seq !== 'number' || evt.seq <= 0) continue
      lastSeq = Math.max(lastSeq, evt.seq)
      if (evt.kind === 'intent_recorded') {
        runs.set(evt.runId, {
          ledgerRunId: evt.runId,
          intentId: evt.intentId ?? `legacy-intent:${evt.runId}`,
          intentSeq: evt.seq,
          intentAt: evt.at,
          detail: evt.detail,
          intentDigest: h1DetailDigest(evt.detail),
          lifecycle: 'recorded',
          lastSeq: evt.seq
        })
      } else {
        const existing = runs.get(evt.runId)
        if (!existing) continue
        existing.lastSeq = Math.max(existing.lastSeq, evt.seq)
        if (evt.kind === 'run_dispatched') existing.lifecycle = 'dispatched'
        else if (evt.kind === 'run_settled') {
          existing.lifecycle = 'settled'
          existing.terminalAt = evt.at
        } else if (evt.kind === 'run_failed') {
          existing.lifecycle = 'failed'
          existing.terminalAt = evt.at
          existing.terminalDetail = evt.detail
        } else if (evt.kind === 'run_cancelled') {
          existing.lifecycle = 'cancelled'
          existing.terminalAt = evt.at
          existing.terminalDetail = evt.detail
        }
      }
    }
  }

  return { lastSeq, runs }
}

function emptyPlan(
  currentLedgerSeq: number,
  lastSeq = currentLedgerSeq,
  runs = new Map<string, LegacyRunState>()
): LegacyLedgerPlan {
  return { currentLedgerSeq, lastSeq, unimportedRuns: [], openRuns: [], runsByLedgerId: runs }
}

function buildLegacyLedgerPlan(
  currentLedgerSeq: number,
  legacy: { lastSeq: number; runs: Map<string, LegacyRunState> }
): LegacyLedgerPlan {
  if (legacy.lastSeq <= currentLedgerSeq) return emptyPlan(currentLedgerSeq, legacy.lastSeq, legacy.runs)
  const unimportedRuns = [...legacy.runs.values()]
    .filter((run) => run.lastSeq > currentLedgerSeq)
    .sort((a, b) => a.intentSeq - b.intentSeq)
  const openRuns = unimportedRuns.filter((run) => run.lifecycle === 'recorded' || run.lifecycle === 'dispatched')
  return { currentLedgerSeq, lastSeq: legacy.lastSeq, unimportedRuns, openRuns, runsByLedgerId: legacy.runs }
}

export function loadLegacyLedgerPlan(sink: EventSink, userDataDir: string): LegacyLedgerPlan {
  const currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  if (!existsSync(ledgerDir)) return emptyPlan(currentLedgerSeq)
  return buildLegacyLedgerPlan(currentLedgerSeq, readLegacyLedgerReadOnly(ledgerDir))
}

export async function loadLegacyLedgerPlanAsync(sink: EventSink, userDataDir: string): Promise<LegacyLedgerPlan> {
  const currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  if (!existsSync(ledgerDir)) return emptyPlan(currentLedgerSeq)
  const streamed = await readLegacyLedgerStreamedAsync(ledgerDir, { minSeqExclusive: currentLedgerSeq })
  if (streamed.lastSeq <= currentLedgerSeq) return emptyPlan(currentLedgerSeq, streamed.lastSeq, streamed.runs)
  const openRuns = streamed.sortedRuns.filter((run) => run.lifecycle === 'recorded' || run.lifecycle === 'dispatched')
  return {
    currentLedgerSeq,
    lastSeq: streamed.lastSeq,
    unimportedRuns: streamed.sortedRuns,
    openRuns,
    runsByLedgerId: streamed.runs
  }
}

export function peekUnimportedLegacyRunCount(sink: EventSink, userDataDir: string): number {
  return loadLegacyLedgerPlan(sink, userDataDir).unimportedRuns.length
}
