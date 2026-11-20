import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LedgerEvent, LedgerSnapshot, LedgerSnapshotRun } from '../../main/remote/session-ledger'

export interface LegacyRunState {
  ledgerRunId: string
  intentId: string
  intentSeq: number
  intentAt: number
  detail?: string
  lifecycle: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled'
  lastSeq: number
  terminalAt?: number
  terminalDetail?: string
}

const LEGACY_LEDGER_WORKER_SOURCE = `
'use strict';
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const ledgerDir = workerData.ledgerDir;
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

parentPort.postMessage({ lastSeq, entries: [...runs.entries()] });
`

/**
 * Off-main-thread parser for H1 `session-ledger.snapshot.json` + `session-ledger.log` (W9 P4-2).
 * Uses an inline `worker_threads` worker so 100k-run ledgers never block the daemon event loop.
 */
export function readLegacyLedgerAsync(
  ledgerDir: string
): Promise<{ lastSeq: number; runs: Map<string, LegacyRunState> }> {
  if (!existsSync(ledgerDir)) {
    return Promise.resolve({ lastSeq: 0, runs: new Map() })
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(LEGACY_LEDGER_WORKER_SOURCE, {
      eval: true,
      workerData: { ledgerDir }
    })
    let settled = false
    worker.once('message', (msg: { lastSeq: number; entries: Array<[string, LegacyRunState]> }) => {
      settled = true
      resolve({ lastSeq: msg.lastSeq, runs: new Map(msg.entries) })
    })
    worker.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      reject(new Error(`legacy ledger worker exited unexpectedly with code ${code}`))
    })
  })
}

/** Read-only parser for H1 `session-ledger.snapshot.json` + `session-ledger.log`. */
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
