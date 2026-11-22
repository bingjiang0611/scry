import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

describe('v3 retirement', () => {
  it('keeps daemon authority enabled independently of the former environment switch', () => {
    expect(source('src/daemon/host-process.ts')).not.toMatch(/parseOrchestrationMode|orchestrationShadow/)
    expect(source('src/daemon/host-process-dispose.ts')).not.toMatch(/reconcileH1ForOffMode|attachDaemonOrchestrationShadow/)
    expect(source('src/daemon/supervisor.ts')).not.toContain("'SCRY_ORCHESTRATION'")
    expect(source('src/main/bootstrap/daemon-run-mode.ts')).toContain("throw new Error('daemon_subscribe_unavailable')")
    expect(source('src/main/daemon-run-events.ts')).not.toContain('DaemonRunDiscovery')
  })

  it('keeps App lifecycle and question recovery on the subscription', () => {
    expect(source('src/main/remote/host-run-control.ts')).not.toMatch(/probeLifecycle|pendingQuestions/)
    expect(source('src/main/daemon-run-subscribe.ts')).toContain('event.runRow?.questions')
  })

  it.each([
    ['src/main/remote/host-controller-surface.ts', /LiveWatchers|watchLifecycle|watchRun\(|liveRuns\(/],
    ['src/renderer/components/RemoteChatControls.tsx', /useVisibilityPolling|createTraceReadScheduler/],
    ['src/renderer/hooks/useRemoteCatalogs.ts', /useVisibilityPolling/],
    ['apps/ios/ScryRemote/RunStore/RemoteRunStoreObservation.swift', /800_000_000/],
    ['apps/ios/ScryRemote/SessionTranscriptView.swift', /3_000_000_000|historyIsWatched/]
  ] as const)('removes the former periodic read from %s', (path, retired) => {
    expect(retired.test(source(path))).toBe(false)
  })
})
