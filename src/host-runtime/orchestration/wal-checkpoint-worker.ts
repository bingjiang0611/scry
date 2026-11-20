import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { WalCheckpointResult, WalCheckpointSample } from './db'
import type { EventSink } from './event-sink'

const require = createRequire(import.meta.url)

const CHECKPOINT_WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const { existsSync, statSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const Database = require(workerData.betterSqlite3Path);

const dbPath = workerData.dbPath;
const walPath = dbPath + '-wal';
const walBytes = () => {
  try { return existsSync(walPath) ? statSync(walPath).size : 0; } catch { return 0; }
};

let db = null;
try {
  db = new Database(dbPath, { timeout: 5000 });
  db.pragma('checkpoint_fullfsync = ' + (workerData.checkpointFullfsync ? 'ON' : 'OFF'));
  parentPort.postMessage({ type: 'ready' });
} catch (err) {
  parentPort.postMessage({ type: 'init_error', message: err && err.message ? err.message : String(err) });
  process.exit(0);
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'close') {
    try { if (db && db.open) db.close(); } catch {}
    parentPort.postMessage({ type: 'closed', id: msg.id });
    process.exit(0);
    return;
  }
  if (msg.type === 'checkpoint') {
    const mode = msg.mode === 'truncate' ? 'truncate' : 'passive';
    const walBytesBefore = walBytes();
    const started = performance.now();
    try {
      const pragma = mode === 'truncate' ? 'wal_checkpoint(TRUNCATE)' : 'wal_checkpoint(PASSIVE)';
      const rows = db.pragma(pragma);
      const row = Array.isArray(rows) ? rows[0] : rows;
      const durationMs = Number((performance.now() - started).toFixed(2));
      parentPort.postMessage({
        type: 'checkpoint_done',
        id: msg.id,
        sample: {
          mode,
          durationMs,
          walBytesBefore,
          walBytesAfter: walBytes(),
          result: {
            busy: Number((row && row.busy) || 0),
            log: Number((row && row.log) || 0),
            checkpointed: Number((row && row.checkpointed) || 0)
          }
        }
      });
    } catch (err) {
      const durationMs = Number((performance.now() - started).toFixed(2));
      parentPort.postMessage({
        type: 'checkpoint_done',
        id: msg.id,
        error: err && err.message ? err.message : String(err),
        sample: {
          mode,
          durationMs,
          walBytesBefore,
          walBytesAfter: walBytes(),
          result: { busy: 1, log: 0, checkpointed: 0 }
        }
      });
    }
  }
});
`

/**
 * Off-main-thread SQLite WAL checkpoint helper for large deferred backfills (W9 Must-Fix 1).
 * Temporarily switches the main connection to `locking_mode = NORMAL` while the same-process
 * daemon lock (`daemon.lock`) still owns exclusive host access, runs `PRAGMA wal_checkpoint(PASSIVE)`
 * on an independent connection in a worker thread (non-blocking for main-thread writers and event
 * loop), and immediately restores `locking_mode = EXCLUSIVE` on `close()`.
 */
export class WalCheckpointWorker {
  readonly #sink: EventSink
  #worker: Worker | null = null
  #ready = false
  #closed = false
  #restoredExclusive = false
  #nextId = 1
  #inFlight: Promise<WalCheckpointSample | null> | null = null
  #readyQueue: Array<() => void> = []
  readonly #pending = new Map<number, (sample: WalCheckpointSample | null) => void>()

  private constructor(sink: EventSink) {
    this.#sink = sink
  }

  static start(sink: EventSink): WalCheckpointWorker {
    const inst = new WalCheckpointWorker(sink)
    inst.#init()
    return inst
  }

  #init(): void {
    if (this.#sink.isWriteIndeterminate() || !this.#sink.handle.db.open) return
    try {
      this.#sink.setLockingMode('normal')
      const betterSqlite3Path = require.resolve('better-sqlite3')
      const worker = new Worker(CHECKPOINT_WORKER_CODE, {
        eval: true,
        workerData: {
          dbPath: this.#sink.handle.dbPath,
          betterSqlite3Path,
          checkpointFullfsync: this.#sink.handle.checkpointFullfsync
        }
      })
      this.#worker = worker
      worker.on('message', (msg: { type?: string; id?: number; sample?: WalCheckpointSample }) => {
        if (msg.type === 'ready') {
          this.#ready = true
          for (const fn of this.#readyQueue.splice(0)) fn()
          return
        }
        if (msg.type === 'init_error') {
          this.#worker = null
          this.#ready = false
          for (const fn of this.#readyQueue.splice(0)) fn()
          this.#resolveAll(null)
          return
        }
        if (msg.type === 'checkpoint_done' && typeof msg.id === 'number') {
          const resolve = this.#pending.get(msg.id)
          this.#pending.delete(msg.id)
          if (msg.sample) {
            this.#sink.recordExternalCheckpoint(msg.sample)
          }
          resolve?.(msg.sample ?? null)
        }
      })
      worker.on('error', () => {
        this.#worker = null
        this.#ready = false
        for (const fn of this.#readyQueue.splice(0)) fn()
        this.#resolveAll(null)
      })
      worker.on('exit', () => {
        this.#worker = null
        this.#ready = false
        for (const fn of this.#readyQueue.splice(0)) fn()
        this.#resolveAll(null)
      })
      worker.unref()
    } catch {
      this.#restoreExclusive()
    }
  }

  #resolveAll(value: WalCheckpointSample | null): void {
    for (const resolve of this.#pending.values()) resolve(value)
    this.#pending.clear()
  }

  isBusy(): boolean {
    return this.#inFlight !== null
  }

  waitInFlight(): Promise<WalCheckpointSample | null> {
    return this.#inFlight ?? Promise.resolve(null)
  }

  request(mode: 'passive' | 'truncate'): Promise<WalCheckpointSample | null> {
    if (this.#closed || !this.#worker || this.#sink.isWriteIndeterminate() || !this.#sink.handle.db.open) {
      return Promise.resolve(null)
    }
    if (this.#inFlight) return this.#inFlight
    const id = this.#nextId++
    const p = new Promise<WalCheckpointSample | null>((resolve) => {
      const dispatch = (): void => {
        if (this.#closed || !this.#worker || !this.#ready) {
          resolve(null)
          return
        }
        this.#pending.set(id, resolve)
        try {
          this.#worker.postMessage({ type: 'checkpoint', id, mode })
        } catch {
          this.#pending.delete(id)
          resolve(null)
        }
      }
      if (this.#ready) dispatch()
      else this.#readyQueue.push(dispatch)
    }).finally(() => {
      if (this.#inFlight === p) this.#inFlight = null
    })
    this.#inFlight = p
    return p
  }

  #restoreExclusive(): void {
    if (this.#restoredExclusive) return
    this.#restoredExclusive = true
    if (!this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        this.#sink.setLockingMode('exclusive')
      } catch {
        // Ignore if DB already closed or fenced.
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const worker = this.#worker
    if (worker) {
      await new Promise<void>((resolve) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          void worker.terminate().finally(finish)
        }, 5_000)
        timer.unref?.()
        worker.once('exit', finish)
        try {
          worker.postMessage({ type: 'close', id: this.#nextId++ })
        } catch {
          void worker.terminate().finally(finish)
        }
      })
      this.#worker = null
    }
    this.#resolveAll(null)
    this.#restoreExclusive()
  }
}

export type { WalCheckpointResult, WalCheckpointSample }
