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

function filesMentioning(pattern: string, paths: string[]): string[] {
  const result = spawnSync('git', ['grep', '-Elzw', '--untracked', '-e', pattern, '--', ...paths], {
    cwd: repository, encoding: 'utf8'
  })
  if (result.error) throw result.error
  if (result.status === 1) return []
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.split('\0').filter(Boolean)
}

// Local UI clocks and diagnostics, plus existing pairing/connection status refresh.
const rendererTimerExceptions: Readonly<Record<string, readonly string[]>> = {
  'src/renderer/components/BackgroundNotices.tsx': ['const timer = window.setInterval(() => {'],
  'src/renderer/components/BackgroundWorkPanel.tsx': ['const timer = window.setInterval(() => setNow(Date.now()), 10_000)'],
  'src/renderer/components/chat-view/RunElapsed.tsx': ['timer = window.setInterval(() => setNowTick((n) => n + 1), 1000)'],
  'src/renderer/components/primitives/CountProgress.tsx': ['const timer = setInterval(() => setNow(Date.now()), 1_000)'],
  'src/renderer/performance-monitor.ts': ['timerId = window.setInterval(() => {'],
  'src/renderer/components/RemotePairing.tsx': [
    "import { useVisibilityPolling } from '../hooks/useVisibilityPolling'",
    "useVisibilityPolling('remote-pairing', refresh, 2000, () => {"
  ],
  'src/renderer/hooks/useDesktopConnections.ts': [
    "import { createVisibilityPollingController } from './useVisibilityPolling'",
    'const polling = createVisibilityPollingController(refreshDesktopConnections, 3000, undefined, () => {'
  ],
  // 机器页页头的「x 秒前更新」时钟：只让这一个标签重渲染，不读任何数据。
  'src/renderer/hooks/useMachines.ts': ['const timer = setInterval(() => setNow(Date.now()), 1_000)'],
  'src/renderer/hooks/useVisibilityPolling.ts': [
    'setInterval: (callback: () => void, delay: number) => TimerHandle',
    'setInterval: (callback, delay) => window.setInterval(callback, delay),',
    'export function createVisibilityPollingController(',
    'timer = environment.setInterval(() => requestRefresh(), delay)',
    'export function useVisibilityPolling(',
    'const controllerRef = useRef<ReturnType<typeof createVisibilityPollingController> | undefined>(undefined)',
    'controllerRef.current ??= createVisibilityPollingController(() => refreshRef.current(), intervalMs, undefined, () => invalidateRef.current())'
  ]
}

describe('v3 retirement', () => {
  it('keeps the retired live-run timer out of repository source', () => {
    expect(filesMentioning('LIVE_RUNS_TICK_MS', [':(exclude,glob)**/*.md'])
      .filter((file) => file !== 'src/main/remote/protocol-v3-retirement.test.ts')).toEqual([])
  })

  it('permits only the documented renderer timers and settings refreshes', () => {
    const methods = 'setInterval|useVisibilityPolling|createVisibilityPollingController'
    const timer = new RegExp('\\b(' + methods + ')\\b')
    const files = filesMentioning(methods, [
      'src/renderer', ':(exclude,glob)**/*.test.*'
    ])
    const unexpected: Array<{ file: string; line: string }> = []
    for (const file of files) {
      const known = [...(rendererTimerExceptions[file] ?? [])]
      for (const line of source(file).split('\n').map((line) => line.trim()).filter((line) => timer.test(line))) {
        const expected = known.indexOf(line)
        if (expected < 0) unexpected.push({ file, line })
        else known.splice(expected, 1)
      }
    }
    expect(unexpected).toEqual([])
  })

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
