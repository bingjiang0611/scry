import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { startOrchestrationMaintenance } from './orchestration-maintenance'

function withSink(run: (sink: EventSink) => void): void {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-b2-sched-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    run(sink)
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

it('runs a retention pass on demand and logs its outcome', () => {
  withSink((sink) => {
    const lines: string[] = []
    const maintenance = startOrchestrationMaintenance({
      sink,
      now: () => 100 * 3_600_000,
      eventRetentionMs: 3_600_000,
      log: (line) => lines.push(line)
    })
    try {
      const report = maintenance.runOnce()
      expect(report).toMatchObject({ deletedEvents: 0, deletedOutbox: 0 })
      expect(lines.at(-1)).toContain('daemon.orchestration-retention events=0')
    } finally {
      maintenance.stop()
    }
  })
})

it('does nothing once the store is closed instead of writing through it', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-b2-sched-closed-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  const maintenance = startOrchestrationMaintenance({ sink, now: () => 100 * 3_600_000, log: () => undefined })
  try {
    sink.close()
    expect(sink.handle.db.open).toBe(false)
    expect(maintenance.runOnce()).toBeUndefined()
  } finally {
    maintenance.stop()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// R13: retention prune is the only writer here; a fatal IO error used to be logged and forgotten, so the
// store kept accepting writes after a failure that made committed state unknowable.
it('fences the store when the prune fails fatally', () => {
  withSink((sink) => {
    const lines: string[] = []
    const original = sink.handle.db.prepare.bind(sink.handle.db)
    ;(sink.handle.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('DELETE FROM orch_event')) {
        throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' })
      }
      return original(sql)
    }
    const maintenance = startOrchestrationMaintenance({ sink, now: () => 100 * 3_600_000, log: (line) => lines.push(line) })
    try {
      expect(maintenance.runOnce()).toBeUndefined()
      expect(sink.isWriteIndeterminate()).toBe(true)
      expect(lines.at(-1)).toContain('daemon.orchestration-retention-fenced')
    } finally {
      ;(sink.handle.db as unknown as { prepare: typeof original }).prepare = original
      maintenance.stop()
    }
  })
})
