import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceDiffResult } from '../../src/shared/trace'
import { PinnedSummary } from '../../src/renderer/components/PinnedSummary'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import { useIntegrations } from '../../src/renderer/hooks/useIntegrations'
import { buildSessionReport } from '../../src/renderer/format'
import { DiffHistorySmoke, historyApi } from './diff-history-smoke'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'

const reads = { stats: 0, billing: 0, analytics: 0 }
let dataUpdated: (() => void) | undefined
let mode = 'clean'
let release: ((value: WorkspaceDiffResult) => void) | undefined
window.scry = {
  ...historyApi,
  detect: async () => [],
  usageStats: async () => null,
  stats: async () => { reads.stats++; return null },
  billingState: async () => { reads.billing++; return null },
  usageAnalytics: async () => { reads.analytics++; return { status: 'unavailable' } },
  onDataUpdated: (listener: () => void) => {
    dataUpdated = listener
    return () => { dataUpdated = undefined }
  },
  gitDiff: async () => {
    if (mode === 'reject') throw new Error('fixture: IPC rejected')
    if (mode === 'pending') return new Promise<WorkspaceDiffResult>((resolve) => { release = resolve })
    if (mode === 'dirty') return { status: 'captured', collectedAt: '2026-10-22T12:00:00Z', files: [{ path: '/fixture/a.ts', added: 5, deleted: 2 }] }
    if (mode === 'unavailable') return { status: 'unavailable', reason: 'not_git', files: [] }
    if (mode === 'timeout') return { status: 'timeout', reason: 'deadline', files: [] }
    return { status: 'captured', files: [] }
  }
} as unknown as typeof window.scry

function Fixture() {
  const [cwd, setCwd] = useState<string | null>('/fixture/first')
  const integrations = useIntegrations(cwd, null, [], null)
  const controls = ['clean', 'dirty', 'unavailable', 'timeout', 'reject', 'pending', 'switch', 'release', 'unbind', 'analytics', 'data-updated']
  const change = (next: string): void => {
    if (next === 'analytics') {
      integrations.loadAnalytics()
    } else if (next === 'data-updated') {
      dataUpdated?.()
    } else if (next === 'release') {
      release?.({ status: 'captured', files: [{ path: '/fixture/stale.ts', added: 999, deleted: 0 }] })
    } else if (next === 'unbind') {
      setCwd(null)
    } else if (next === 'switch') {
      mode = 'clean'
      setCwd('/fixture/second')
    } else {
      mode = next
      integrations.loadGitDiff()
    }
  }
  return <>
    <DiffHistorySmoke />
    <nav>{controls.map((control) => <button key={control} id={`diff-${control}`} onClick={() => change(control)}>{control}</button>)}</nav>
    <section id="diff-summary">
      <PinnedSummary cwd={cwd} gitDiff={integrations.gitDiff} gitDiffRefreshing={integrations.gitDiffRefreshing} turns={[]} busy={false} temporary={false}
        expandedSections={new Set()} onDismiss={() => undefined} onToggleSection={() => undefined}
        onOpenCall={() => undefined} onOpenAgents={() => undefined} onOpenChanges={() => undefined} />
    </section>
    <section id="diff-overview">
      <OverviewPanel turns={[{ runId: 'fixture', userText: '', done: true, items: [] }]} selected={null} usage={null} stats={null} gitDiff={integrations.gitDiff} gitDiffRefreshing={integrations.gitDiffRefreshing} onSelect={() => undefined} />
    </section>
    <output id="integration-reads" data-stats={reads.stats} data-billing={reads.billing} data-analytics={reads.analytics} />
    <pre id="diff-report">{buildSessionReport([], integrations.gitDiff)}</pre>
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
