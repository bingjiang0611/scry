import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../../src/renderer/styles.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/codex-alignment.css'
import { PinnedSummary, type PinnedSummarySection } from '../../src/renderer/components/PinnedSummary'
import type { Turn } from '../../src/renderer/format'

const expanded = new Set<PinnedSummarySection>(['web', 'inventory', 'agents'])
const noop = () => {}

function snapshot(step: number, scope: string, done: boolean): Turn[] {
  return [{
    runId: scope, userText: 'Synthetic summary performance fixture', done,
    items: [{
      id: `${scope}-text`, runId: scope, ts: new Date(step).toISOString(), kind: 'model', stage: 'text_delta',
      text: `https://example.test/${scope}/${step}`
    }, {
      id: `${scope}-skill`, runId: scope, ts: new Date(step).toISOString(), kind: 'skill', name: `skill-${step}`
    }]
  }]
}

function Fixture() {
  const [state, setState] = useState({ turns: snapshot(0, 'first', false), busy: true, mounted: true })
  Object.assign(window, {
    summaryFixture: {
      push(step: number, scope = 'first', done = false) {
        flushSync(() => setState({ turns: snapshot(step, scope, done), busy: !done, mounted: true }))
      },
      unmount() {
        flushSync(() => setState((current) => ({ ...current, mounted: false })))
      }
    }
  })
  return <div id="summary-performance">
    {state.mounted && <PinnedSummary
      cwd="/tmp/scry-summary-fixture" gitDiff={undefined} turns={state.turns} busy={state.busy}
      temporary={false} expandedSections={expanded} onDismiss={noop} onToggleSection={noop}
      onOpenCall={noop} onOpenAgents={noop}
    />}
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
