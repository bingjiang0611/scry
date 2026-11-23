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
