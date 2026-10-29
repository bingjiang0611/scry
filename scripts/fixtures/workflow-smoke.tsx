import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { emptyWorkflowBridge } from './empty-workflow-bridge'
import { workflowInspectionFixture } from './workflow-inspection-fixture'
import { workflowOutputFixture } from './workflow-output-fixture'
import { workflowWorkspaceFixture } from './workflow-workspace-fixture'
import type { WorkflowApi, WorkflowStopTarget } from '../../src/shared/workflow-api'
import { WORKFLOW_COPY as copy } from '../../src/renderer/constants/copy'
import type { WorkflowSizeSnapshot } from '../../src/shared/workflow-size'
import type { WorkflowPlanPreview, WorkflowProgress } from '../../src/shared/workflow'
import type { DetectedAgent } from '../../src/renderer/env'
import { WorkflowProgressPanel, type WorkflowLaunchRequest } from '../../src/renderer/components/WorkflowProgressPanel'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Isolated UI contract fixture. No Provider, account, native session, or real userData.
const counters = { plans: 0, approvals: 0, starts: 0, stops: 0, nodeStops: 0, nodeRecorded: 0, catalogs: 0, permissionClicks: 0, templateWrites: 0 }
let notify = () => {}
const keys: string[] = []
const stopCommands: string[] = []
const nodeCommands: { workflowId: string; target: WorkflowStopTarget; commandId: string }[] = []
const nodeReceipts = new Set<string>()
const nodeReplies = new Map<string, (lost: boolean) => void>()
document.addEventListener('keydown', event => { keys.push(`${event.key}:${(event.target as HTMLElement).tagName}:${event.isTrusted}`); if (keys.length > 12) keys.shift() })
let finishPlan: (() => void) | undefined
let finishApproval: (() => void) | undefined
let inspection: ReturnType<typeof workflowInspectionFixture> | undefined
let outputInspection: ReturnType<typeof workflowOutputFixture> | undefined
let workspaceInspection: ReturnType<typeof workflowWorkspaceFixture> | undefined
let preview: WorkflowPlanPreview
let progress: WorkflowProgress | undefined
let sizeSnapshot: WorkflowSizeSnapshot = { value: 'medium', source: 'default', fingerprint: '0'.repeat(64) }
const agents = [{ id: 'codex', name: 'Codex fixture' }, { id: 'pi:fixture', name: 'Pi profile fixture' }] as DetectedAgent[]
const request: WorkflowLaunchRequest = { id: 'ui-fixture-command', command: '/scry-workflow run Inspect fixture', cwd: '/fixture',
  orchestrator: { role: 'orchestrator', providerId: 'codex', permissionMode: 'default' } }
const templateWrite = async () => { counters.templateWrites++; throw new Error('Read-only fixture refused template write') }
const api: WorkflowApi = {
  ...emptyWorkflowBridge,
  templates: { ...emptyWorkflowBridge.templates,
    saveDraft: templateWrite, publish: templateWrite, restoreDraft: templateWrite, delete: templateWrite,
    drafts: async () => ({ drafts: workspaceInspection ? [structuredClone(workspaceInspection.draftSummary)] : [] }),
    draft: async id => {
      if (!workspaceInspection || id !== workspaceInspection.templateDraft.draftId) throw new Error('Fixture draft missing')
      return structuredClone(workspaceInspection.templateDraft)
    }
  },
  sizeGuideline: async () => structuredClone(sizeSnapshot),
  setSizeGuideline: async value => {
    sizeSnapshot = { value: value ?? 'medium', source: value === null ? 'default' : 'preference', fingerprint: '0'.repeat(64) }
    return structuredClone(sizeSnapshot)
  },
  plan: async input => {
    counters.plans++
    document.body.dataset.workflowRequest = JSON.stringify(input)
    preview = { planningSize: { snapshot: structuredClone(sizeSnapshot) }, workflowId: 'ui-workflow', programRevision: 'ui-revision', userGoal: 'Inspect fixture', workspace: input.cwd,
      orchestrator: input.orchestrator, plannedCalls: 1, roles: [], state: 'ready', unavailableReasons: [], observedAt: Date.now(),
      program: { schemaVersion: 1, workflowId: 'ui-workflow', programRevision: 'ui-revision', userGoal: 'Inspect fixture', workspace: input.cwd, roles: input.roles,
        body: { kind: 'sequence', blockId: 'root', blocks: [
          ...Array.from({ length: 17 }, (_, index) => ({ kind: 'replica' as const, blockId: `copy_${index}` })),
          { kind: 'check', blockId: 'verify', replica: { kind: 'ref', name: 'copy_0' }, check: { argv: ['node', 'verify.cjs', 'a b', 'literal;$(not-a-shell)'], cwd: '.', timeoutMs: 1500, parser: 'exit_code' } },
          { kind: 'check', blockId: 'pending', replica: { kind: 'ref', name: 'copy_0' }, check: { argv: ['node', 'pending.cjs'], cwd: '.', timeoutMs: 1500, parser: 'exit_code' } },
          { kind: 'call', blockId: 'report', role: 'worker', prompt: 'Inspect fixture', replica: { kind: 'ref', name: 'copy_0' } },
          { kind: 'return', blockId: 'return', ref: { nodeId: 'report' } }
        ] } } }
    notify()
    return new Promise(resolve => { finishPlan = () => resolve(preview) })
  },
  preview: async id => workspaceInspection?.preview(id) ?? inspection?.preview() ?? preview,
  inspectExecution: input => workspaceInspection ? workspaceInspection.inspectExecution(input) : inspection ? inspection.inspectExecution(input) : emptyWorkflowBridge.inspectExecution(input),
  inspectFrame: (id, frameId) => workspaceInspection ? workspaceInspection.inspectFrame(id, frameId) : inspection ? inspection.inspectFrame(id, frameId) : emptyWorkflowBridge.inspectFrame(id, frameId),
  inspectOutput: input => outputInspection ? outputInspection.inspectOutput(input) : emptyWorkflowBridge.inspectOutput(input),
  sourceApplications: (workflowId, programRevision) => workspaceInspection ? workspaceInspection.sourceApplications(workflowId, programRevision) : emptyWorkflowBridge.sourceApplications(workflowId, programRevision),
  applySourceApplication: command => workspaceInspection ? workspaceInspection.applySourceApplication(command) : emptyWorkflowBridge.applySourceApplication(command),
  approve: async approval => {
    if (approval.programRevision !== preview.programRevision) throw new Error('Wrong immutable revision')
    counters.approvals++; notify()
    return new Promise(resolve => { finishApproval = () => resolve(true) })
  },
  start: async () => {
    counters.starts++
    progress = { planningSize: preview.planningSize, workflowId: preview.workflowId, programRevision: preview.programRevision, workspace: preview.workspace,
      goal: preview.userGoal, state: 'running', dispatchAttempts: 1, revision: 2, updatedAt: Date.now(), finalReportStatus: 'unavailable',
      attempts: [{ attemptId: 'attempt', taskId: 'task', nodeId: 'report', role: 'worker', providerId: 'codex', actualModelStatus: 'unknown', state: 'running', settled: false }],
      slots: { limit: 2, inUse: 1, queued: 0 },
      systemSteps: [{ stepId: 'fixture-system', nodeId: 'verify', kind: 'check', state: 'completed', settled: true,
        result: { state: 'failed', exitCode: 17, signal: null, startedAt: 1, finishedAt: 2, settled: true, truncated: false, evidence: 'exact',
          stdoutRef: { workflowId: 'ui-workflow', key: 'stdout', hash: '0'.repeat(64) }, stderrRef: { workflowId: 'ui-workflow', key: 'stderr', hash: '0'.repeat(64) }, diagnostics: { state: 'unavailable', reason: 'fixture only' } } },
        { stepId: 'fixture-verification', nodeId: 'required', kind: 'verification', state: 'completed', settled: true },
        { stepId: 'fixture-pending', nodeId: 'pending', kind: 'check', state: 'running', settled: false }] }
    notify()
    return progress
  },
  resume: async () => { throw new Error('Continuation is disabled in this fixture') },
  retry: async () => { throw new Error('Retry is disabled in this fixture') },
  stopNode: async (workflowId, target, commandId) => {
    counters.nodeStops++
    nodeCommands.push({ workflowId, target: { ...target }, commandId })
    const current = progress
    if (!current || current.workflowId !== workflowId) return false
    if (nodeReceipts.has(commandId)) return true
    const row = target.kind === 'attempt' ? current.attempts.find(attempt => attempt.attemptId === target.id)
      : current.systemSteps?.find(step => step.stepId === target.id)
    if (!row || row.settled) return false
    nodeReceipts.add(commandId)
    counters.nodeRecorded++
    const stopRequested = { commandId, requestedAt: Date.now() }
    progress = { ...current, revision: (current.revision ?? 0) + 1,
      attempts: current.attempts.map(attempt => target.kind === 'attempt' && attempt.attemptId === target.id ? { ...attempt, stopRequested } : attempt),
      systemSteps: current.systemSteps?.map(step => target.kind === 'system' && step.stepId === target.id ? { ...step, stopRequested } : step) }
    notify()
    // Hold only the acknowledgment. The fixture never claims a physical stop.
    return new Promise((resolve, reject) => {
      nodeReplies.set(commandId, lost => {
        nodeReplies.delete(commandId)
        if (lost) reject(new Error(copy.nodeStopReplyUnknown))
        else resolve(true)
      })
    })
  },
  stop: async (_id, commandId) => {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(commandId)) throw new Error('Missing stop command identity')
    stopCommands.push(commandId)
    counters.stops++
    if (progress) progress = { ...progress, stopRequestedAt: Date.now(), revision: (progress.revision ?? 0) + 1 }
    notify()
    return true
  },
  snapshot: async () => progress ?? null,
  list: async cwd => ({ records: progress && progress.workspace === cwd ? [structuredClone(progress)] : [], unresolvedPlanning: 0 }),
  cancelPlanning: async () => true,
  onProgress: listener => workspaceInspection ? workspaceInspection.onProgress(listener) : () => {}
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
Object.assign(window, { workflowFixture: { counters, keys, stopCommands, nodeCommands,
  installInspection: () => { workspaceInspection = undefined; outputInspection = undefined; inspection = workflowInspectionFixture(); progress = inspection.progress; document.dispatchEvent(new Event('fixture-remount')) },
  installWorkspace: () => { workspaceInspection = workflowWorkspaceFixture(); outputInspection = undefined; inspection = undefined; progress = workspaceInspection.progress; document.dispatchEvent(new Event('fixture-remount')) },
  workspaceQueries: () => workspaceInspection?.queries,
  workspaceFrameQueries: () => workspaceInspection?.frameQueries,
  sourceApplicationCommands: () => workspaceInspection?.applicationCommands,
  changeWorkspaceSource: () => workspaceInspection?.changeSource(),
  changeWorkspaceProject: () => document.dispatchEvent(new Event('fixture-project-change')),
  installOutputInspection: () => { workspaceInspection = undefined; outputInspection = workflowOutputFixture(); inspection = outputInspection; progress = inspection.progress; document.dispatchEvent(new Event('fixture-remount')) },
  outputQueries: () => outputInspection?.outputQueries,
  failOutput: () => outputInspection?.failOutput(),
  changeOutput: () => outputInspection?.changeOutput(),
  rerenderInspection: () => notify(),
  inspectionQueries: () => inspection?.queries,
  changeInspectionSource: () => inspection?.changeSource(),
  installSizeFileOverride: () => { sizeSnapshot = { value: 'large', source: 'file', fingerprint: 'f'.repeat(64) } },
  restoreSizePreference: () => { sizeSnapshot = { value: 'small', source: 'preference', fingerprint: '0'.repeat(64) } },
  installAutomaticReceipt: () => {
    if (!progress) throw new Error('Automatic receipt requires the existing fixture run')
    progress = { ...progress, revision: (progress.revision ?? 0) + 1, attempts: progress.attempts.map(attempt => ({ ...attempt,
      stopRequested: { commandId: 'automatic-policy-receipt', requestedAt: 1,
        provenance: { source: 'auto', policy: 'fail_fast', trigger: { nodeId: 'critical'.repeat(12), phase: 'failed', frameId: 'scope-frame' } } }
    })) }
    notify()
  },
  finishNodeStop: (lost = false) => { const id = nodeCommands.at(-1)?.commandId; if (id) nodeReplies.get(id)?.(lost) },
  markUnknown: () => { if (progress) progress = { ...progress, state: 'unknown', revision: (progress.revision ?? 0) + 1 } }, finishPlan: () => finishPlan?.(), finishApproval: () => finishApproval?.(),
  rehydrate: () => { document.dispatchEvent(new Event('fixture-remount')) } } })

function Fixture() {
  const [renderVersion, version] = useState(0)
  const [launch, setLaunch] = useState<WorkflowLaunchRequest | null>(request)
  const [key, setKey] = useState(0)
  const [cwd, setCwd] = useState('/fixture')
  useEffect(() => {
    const change = () => setCwd('/fixture-next')
    document.addEventListener('fixture-project-change', change)
    return () => document.removeEventListener('fixture-project-change', change)
  }, [])
  useEffect(() => { document.body.dataset.fixtureCwd = cwd }, [cwd])
  notify = () => version(value => value + 1)
  useEffect(() => { document.body.dataset.workflowFixtureRender = String(renderVersion) }, [renderVersion])
  // Remount against the same fake main-side records, not a new request.
  useEffect(() => {
    const remount = () => { if (workspaceInspection) setLaunch(null); setKey(value => value + 1) }
    document.addEventListener('fixture-remount', remount)
    return () => document.removeEventListener('fixture-remount', remount)
  }, [])
  return <main data-workflow-fixture-generation={key} style={{ padding: 16 }}>
    <textarea style={{ maxWidth: '100%' }} id="parent-composer" defaultValue="PARENT_UNCHANGED" aria-label="fixture parent" />
    <output id="counters" style={{ display: 'none' }}>{JSON.stringify(counters)}</output>
    {counters.plans > 0 && !counters.permissionClicks && <section role="dialog" aria-modal="true" id="native-permission">
      <button id="allow-native-permission" onClick={() => { counters.permissionClicks++; notify() }}>Native permission fixture</button>
    </section>}
    <WorkflowProgressPanel key={key} request={launch} cwd={cwd} agents={agents} onDismiss={() => setLaunch(null)} />
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
