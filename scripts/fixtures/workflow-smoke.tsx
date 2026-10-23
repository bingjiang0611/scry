import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { emptyWorkflowBridge } from './empty-workflow-bridge'
import type { WorkflowApi } from '../../src/shared/workflow-api'
import type { WorkflowPlanPreview, WorkflowProgress } from '../../src/shared/workflow'
import type { DetectedAgent } from '../../src/renderer/env'
import { WorkflowProgressPanel, type WorkflowLaunchRequest } from '../../src/renderer/components/WorkflowProgressPanel'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Isolated UI contract fixture. No Provider, account, native session, or real userData.
const counters = { plans: 0, approvals: 0, starts: 0, stops: 0, catalogs: 0, permissionClicks: 0 }
let notify = () => {}
const keys: string[] = []
const stopCommands: string[] = []
document.addEventListener('keydown', event => { keys.push(`${event.key}:${(event.target as HTMLElement).tagName}:${event.isTrusted}`); if (keys.length > 12) keys.shift() })
let finishPlan: (() => void) | undefined
let finishApproval: (() => void) | undefined
let preview: WorkflowPlanPreview
let progress: WorkflowProgress | undefined
const agents = [{ id: 'codex', name: 'Codex fixture' }, { id: 'pi:fixture', name: 'Pi profile fixture' }] as DetectedAgent[]
const request: WorkflowLaunchRequest = { id: 'ui-fixture-command', command: '/scry-workflow run Inspect fixture', cwd: '/fixture',
  orchestrator: { role: 'orchestrator', providerId: 'codex', permissionMode: 'default' } }
const api: WorkflowApi = {
  templates: emptyWorkflowBridge.templates,
  instantiateTemplate: emptyWorkflowBridge.instantiateTemplate,
  plan: async input => {
    counters.plans++
    document.body.dataset.workflowRequest = JSON.stringify(input)
    preview = { workflowId: 'ui-workflow', programRevision: 'ui-revision', userGoal: 'Inspect fixture', workspace: input.cwd,
      orchestrator: input.orchestrator, plannedCalls: 1, roles: [], state: 'ready', unavailableReasons: [], observedAt: Date.now(),
      program: { schemaVersion: 1, workflowId: 'ui-workflow', programRevision: 'ui-revision', userGoal: 'Inspect fixture', workspace: input.cwd, roles: input.roles,
        body: { kind: 'sequence', blockId: 'root', blocks: [
          { kind: 'call', blockId: 'report', role: 'worker', prompt: 'Inspect fixture' },
          { kind: 'return', blockId: 'return', ref: { nodeId: 'report' } }
        ] } } }
    notify()
    return new Promise(resolve => { finishPlan = () => resolve(preview) })
  },
  preview: async () => preview,
  approve: async approval => {
    if (approval.programRevision !== preview.programRevision) throw new Error('Wrong immutable revision')
    counters.approvals++; notify()
    return new Promise(resolve => { finishApproval = () => resolve(true) })
  },
  start: async () => {
    counters.starts++
    progress = { workflowId: preview.workflowId, programRevision: preview.programRevision, workspace: preview.workspace,
      goal: preview.userGoal, state: 'running', dispatchAttempts: 1, revision: 2, updatedAt: Date.now(), finalReportStatus: 'unavailable',
      attempts: [{ attemptId: 'attempt', taskId: 'task', nodeId: 'report', role: 'worker', providerId: 'codex', actualModelStatus: 'unknown', state: 'running', settled: false }],
      slots: { limit: 2, inUse: 1, queued: 0 } }
    notify()
    return progress
  },
  resume: async () => { throw new Error('Continuation is disabled in this fixture') },
  stop: async (_id, commandId) => {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(commandId)) throw new Error('Missing stop command identity')
    stopCommands.push(commandId)
    counters.stops++
    if (progress) progress = { ...progress, stopRequestedAt: Date.now(), revision: (progress.revision ?? 0) + 1 }
    notify()
    return true
  },
  snapshot: async () => progress ?? null,
  list: async () => ({ records: progress ? [progress] : [], unresolvedPlanning: 0 }),
  cancelPlanning: async () => true,
  onProgress: () => () => {}
}
Object.defineProperty(window, 'scry', { configurable: true, value: { workflow: api,
  runControls: async (context: { providerId: string }) => {
    counters.catalogs++; notify()
    return { ...context, mode: 'read', state: 'ready', data: {
      models: [{ model: { id: context.providerId === 'pi' ? 'vendor-model' : 'codex-model', providerId: context.providerId === 'pi' ? 'different-vendor' : undefined }, label: 'Explicit fixture model', efforts: [] }],
      permissions: context.providerId === 'pi'
        ? [{ id: 'full_access', label: 'Explicit native full access', description: 'Fixture only; no isolation' }]
        : [{ id: 'default', label: 'Native default approval', description: 'Fixture only' }]
    } }
  }
} })
Object.assign(window, { workflowFixture: { counters, keys, stopCommands,
  markUnknown: () => { if (progress) progress = { ...progress, state: 'unknown', revision: (progress.revision ?? 0) + 1 } }, finishPlan: () => finishPlan?.(), finishApproval: () => finishApproval?.(),
  rehydrate: () => { document.dispatchEvent(new Event('fixture-remount')) } } })

function Fixture() {
  const [, version] = useState(0)
  const [launch, setLaunch] = useState<WorkflowLaunchRequest | null>(request)
  const [key, setKey] = useState(0)
  notify = () => version(value => value + 1)
  // Remount against the same fake main-side records, not a new request.
  useEffect(() => {
    const remount = () => setKey(value => value + 1)
    document.addEventListener('fixture-remount', remount)
    return () => document.removeEventListener('fixture-remount', remount)
  }, [])
  return <main style={{ padding: 16 }}>
    <textarea style={{ maxWidth: '100%' }} id="parent-composer" defaultValue="PARENT_UNCHANGED" aria-label="fixture parent" />
    <output id="counters" style={{ display: 'none' }}>{JSON.stringify(counters)}</output>
    {counters.plans > 0 && !counters.permissionClicks && <section role="dialog" aria-modal="true" id="native-permission">
      <button id="allow-native-permission" onClick={() => { counters.permissionClicks++; notify() }}>Native permission fixture</button>
    </section>}
    <WorkflowProgressPanel key={key} request={launch} cwd="/fixture" agents={agents} onDismiss={() => setLaunch(null)} />
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
