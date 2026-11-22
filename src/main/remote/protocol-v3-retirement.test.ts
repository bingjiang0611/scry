import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const source = (path: string): string => readFileSync(join(repository, path), 'utf8')

const staleModeContracts = new Set([
  'src/daemon/host-process-orchestration-r12-seq-reset.test.ts',
  'src/daemon/host-process-orchestration-subscribe.test.ts',
  'src/daemon/host-process-trial-defaults.test.ts',
  'src/daemon/supervisor.test.ts',
  'src/main/daemon-subscribe-integration.test.ts',
  'src/main/remote/protocol-v3-retirement.test.ts'
])

function filesMentioning(word: string, paths: string[]): string[] {
  const result = spawnSync('git', ['grep', '-lzw', '--untracked', '-e', word, '--', ...paths], {
    cwd: repository, encoding: 'utf8'
  })
  if (result.error) throw result.error
  if (result.status === 1) return []
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.split('\0').filter(Boolean)
}

describe('v3 retirement', () => {
  it('keeps the retired environment switch only in explicit compatibility tests', () => {
    expect(filesMentioning('SCRY_ORCHESTRATION', ['src']).filter((file) =>
      !staleModeContracts.has(file)
    )).toEqual([])
    expect(source('scripts/desktop-remote-ui-smoke/sidebar-activity.mjs')).not.toContain('No explicit refresh')
  })

  it('removes the obsolete HostController lifecycle and question readers', () => {
    expect(source('src/main/remote/host-controller-surface.ts')).not
      .toMatch(/^  (poll|runState|pendingQuestions)\(/m)
  })

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
