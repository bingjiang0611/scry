import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceDiffResult } from '../../src/shared/trace'
import { PinnedSummary } from '../../src/renderer/components/PinnedSummary'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import { useIntegrations } from '../../src/renderer/hooks/useIntegrations'
import { buildSessionReport } from '../../src/renderer/format'
import '../../src/renderer/styles.css'

let mode = 'clean'
let release: ((value: WorkspaceDiffResult) => void) | undefined
window.scry = {
  detect: async () => [],
  usageStats: async () => null,
  stats: async () => null,
  gitDiff: async () => {
    if (mode === 'reject') throw new Error('fixture: IPC rejected')
    if (mode === 'pending') return new Promise<WorkspaceDiffResult>((resolve) => { release = resolve })
    if (mode === 'dirty') return { status: 'captured', files: [{ path: '/fixture/a.ts', added: 5, deleted: 2 }] }
    if (mode === 'unavailable') return { status: 'unavailable', reason: 'not_git', files: [] }
    if (mode === 'timeout') return { status: 'timeout', reason: 'deadline', files: [] }
    return { status: 'captured', files: [] }
  }
} as unknown as typeof window.scry

function Fixture() {
  const [cwd, setCwd] = useState<string | null>('/fixture/first')
  const integrations = useIntegrations(cwd, null, [], null)
  const controls = ['clean', 'dirty', 'unavailable', 'timeout', 'reject', 'pending', 'switch', 'release', 'unbind']
  const change = (next: string): void => {
    if (next === 'release') {
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
    <nav>{controls.map((control) => <button key={control} id={`diff-${control}`} onClick={() => change(control)}>{control}</button>)}</nav>
    <section id="diff-summary">
      <PinnedSummary cwd={cwd} gitDiff={integrations.gitDiff} turns={[]} busy={false} temporary={false}
        expandedSections={new Set()} onDismiss={() => undefined} onToggleSection={() => undefined}
        onOpenCall={() => undefined} onOpenAgents={() => undefined} onOpenChanges={() => undefined} />
    </section>
    <section id="diff-overview">
      <OverviewPanel turns={[{ runId: 'fixture', userText: '', done: true, items: [] }]} selected={null} usage={null} stats={null} gitDiff={integrations.gitDiff} onSelect={() => undefined} />
    </section>
    <pre id="diff-report">{buildSessionReport([], integrations.gitDiff)}</pre>
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
