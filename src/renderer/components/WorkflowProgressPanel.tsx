import { useEffect, useRef, useState } from 'react'
import { WorkflowRecordedSize } from './WorkflowSizePreference'
import { WorkflowLaunchDialog, workflowLaunchRequest as launchPreview, type WorkflowLaunchRequest } from './WorkflowLaunchDialog'
export type { WorkflowLaunchRequest } from './WorkflowLaunchDialog'
import { WorkflowNodeStopButton } from './WorkflowNodeStopButton'
import { WorkflowFrameInspector } from './WorkflowFrameInspector'
import { WorkflowExecutionInspector } from './WorkflowExecutionInspector'
import { WORKFLOW_INSPECTION_COPY as inspectionCopy } from '../constants/workflow-inspection-copy'
import { WORKFLOW_FRAME_COPY as frameCopy } from '../constants/workflow-frame-copy'
import type { WorkflowPlanPreview, WorkflowProgress } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY as copy, WORKFLOW_TEMPLATE_COPY as templateCopy, WORKFLOW_REVISION_COPY as revisionCopy } from '../constants/copy'
import { WorkflowTemplateWorkbench } from './WorkflowTemplateWorkbench'
import { WorkflowRevisionEditor } from './WorkflowRevisionEditor'
import './workflow.css'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function mergeWorkflowProgress(current: WorkflowProgress[], incoming: WorkflowProgress[]): WorkflowProgress[] {
  const combined = new Map(current.map(progress => [progress.workflowId, progress]))
  for (const progress of incoming) {
    const prior = combined.get(progress.workflowId)
    const durableRevision = progress.revision ?? 0
    const priorRevision = prior?.revision ?? 0
    if (prior && durableRevision < priorRevision) continue
    if (prior?.live && durableRevision === priorRevision && (!progress.live ||
      (prior.live.epoch === progress.live.epoch && progress.live.revision < prior.live.revision))) continue
    combined.set(progress.workflowId, progress)
  }
  return [...combined.values()]
}



export function WorkflowProgressPanel({ request, agents, cwd, onDismiss, onNew }: {
  request: WorkflowLaunchRequest | null
  agents: DetectedAgent[]
  cwd: string | null
  onDismiss: () => void
  onNew?: () => void
}) {
  const [restored, setRestored] = useState<WorkflowLaunchRequest | null>(null)
  const [workbench, setWorkbench] = useState<{ id: string; cwd: string; preview?: WorkflowPlanPreview } | null>(null)
  const [revising, setRevising] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<{ workflowId: string; frameId: string; programRevision: string } | null>(null)
  const [executionId, setExecutionId] = useState<string>()
  const previewEpoch = useRef(0)
  useEffect(() => { if (request) { previewEpoch.current++; setRestored(null); setRevising(null); setInspecting(null); setExecutionId(undefined) } }, [request?.id])
  const activeRequest = request ?? restored
  const [recent, setRecent] = useState<WorkflowProgress[]>([])
  const [history, setHistory] = useState<WorkflowProgress[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [unresolvedPlanning, setUnresolvedPlanning] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const historyEpoch = useRef(0)
  const progresses = mergeWorkflowProgress(history, recent).slice(-40)
  const [error, setError] = useState<string | null>(null)
  const currentCwd = useRef(cwd)
  currentCwd.current = cwd
  const observe = (progress: WorkflowProgress) => {
    if (progress.workspace !== currentCwd.current) return
    setRecent(current => mergeWorkflowProgress(current, [progress]).slice(-20))
  }
  useEffect(() => window.scry.workflow.onProgress(observe), [])
  const loadHistory = (cursor?: string) => {
    const workspace = currentCwd.current
    if (!workspace) return
    const epoch = ++historyEpoch.current
    setLoadingHistory(true)
    void window.scry.workflow.list(workspace, cursor).then(page => {
      if (historyEpoch.current !== epoch) return
      setHistory(page.records); setNextCursor(page.nextCursor); setUnresolvedPlanning(page.unresolvedPlanning ?? 0)
    }).catch(error => { if (historyEpoch.current === epoch) setError(copy.snapshotError(message(error))) })
      .finally(() => { if (historyEpoch.current === epoch) setLoadingHistory(false) })
  }
  useEffect(() => {
    setRecent([]); setHistory([]); setRestored(null); setRevising(null); setInspecting(null); setExecutionId(undefined); setNextCursor(undefined); setUnresolvedPlanning(0); setError(null)
    previewEpoch.current++
    loadHistory()
    return () => { historyEpoch.current++; previewEpoch.current++ }
  }, [cwd])
  const read = (id: string) => { void window.scry.workflow.snapshot(id).then(progress => {
    if (progress) observe(progress)
    else setError(copy.missingSnapshot)
  }).catch(error => setError(copy.snapshotError(message(error)))) }
  const inspectButton = (workflowId: string, programRevision: string, nodeId: string, frameId?: string) => frameId && <button type="button" className="workflow-frame-open"
    data-workflow-frame-open={frameId} aria-label={frameCopy.openNode(nodeId)} onClick={() => {
      previewEpoch.current++
      setInspecting({ workflowId, frameId, programRevision })
    }}>{frameCopy.open}</button>
  return <>
    {executionId && <WorkflowExecutionInspector key={executionId} workflowId={executionId} onClose={() => setExecutionId(undefined)} />}
    {inspecting && <WorkflowFrameInspector key={inspecting.workflowId + ':' + inspecting.frameId} {...inspecting} onClose={() => setInspecting(null)} />}
    {cwd && <div className="workflow-entry-actions">
      <button className="workflow-entry" type="button" onClick={() => setWorkbench({ id: crypto.randomUUID(), cwd })}>{templateCopy.title}</button>
      {onNew && <button className="workflow-entry" type="button" onClick={onNew} title={copy.commandHint}>{copy.title}</button>}
    </div>}
    {revising && <WorkflowRevisionEditor key={revising} workflowId={revising} onClose={() => setRevising(null)} onStarted={observe} />}
    {activeRequest && !workbench && !revising && <WorkflowLaunchDialog key={activeRequest.id} request={activeRequest} agents={agents}
      onDismiss={() => { previewEpoch.current++; setRestored(null); onDismiss() }} onStarted={observe} onError={setError}
      onEdit={preview => { setRestored(launchPreview(preview)); onDismiss(); setWorkbench({ id: crypto.randomUUID(), cwd: preview.workspace, preview }) }} />}
    {workbench && <WorkflowTemplateWorkbench key={workbench.id} cwd={workbench.cwd} agents={agents} orchestrator={workbench.preview?.orchestrator ?? activeRequest?.orchestrator} sourcePreview={workbench.preview}
      onClose={() => setWorkbench(null)} onPrepared={preview => { onDismiss(); setRestored(launchPreview(preview)); setWorkbench(null) }} />}
    {(progresses.length > 0 || error || nextCursor || unresolvedPlanning > 0) && <section className="workflow-progress" aria-label={copy.title}>
      {error && <p role="alert">{error}</p>}
      {unresolvedPlanning > 0 && <p role="alert">{copy.unresolvedPlanning(unresolvedPlanning)}</p>}
      {nextCursor && <button disabled={loadingHistory} type="button" onClick={() => loadHistory(nextCursor)}>{copy.loadMore}</button>}
      {progresses.map(progress => <details key={progress.workflowId} data-workflow-id={progress.workflowId}>
        <summary>{progress.goal} · {progress.stopRequestedAt !== undefined && ['queued', 'running'].includes(progress.state) ? copy.stopPending : copy.status[progress.state]}</summary>
        <code>{progress.workflowId}</code>
        <WorkflowRecordedSize value={progress.planningSize} />
        <button type="button" data-workflow-inspection-open={progress.workflowId} onClick={() => { setInspecting(null); setExecutionId(progress.workflowId) }}>{inspectionCopy.open}</button>
        {['completed', 'failed', 'stopped', 'blocked'].includes(progress.state) && <button type="button" data-workflow-action="revise" onClick={() => setRevising(progress.workflowId)}>{revisionCopy.open}</button>}
        <button type="button" onClick={() => {
          const epoch = ++previewEpoch.current
          void window.scry.workflow.preview(progress.workflowId).then(preview => {
            if (epoch === previewEpoch.current) setWorkbench({ id: crypto.randomUUID(), cwd: preview.workspace, preview })
          }).catch(error => setError(message(error)))
        }}>{templateCopy.extract}</button>
        {progress.state === 'awaiting_approval' && <button type="button" onClick={() => {
          const epoch = ++previewEpoch.current
          void window.scry.workflow.preview(progress.workflowId).then(preview => {
            if (epoch !== previewEpoch.current) return
            setRestored({ id: crypto.randomUUID(), command: `/scry-workflow run ${preview.userGoal}`, cwd: preview.workspace, orchestrator: preview.orchestrator, preview })
          }).catch(error => setError(message(error)))
        }}>{copy.viewPlan}</button>}
        <p>{copy.count(progress.dispatchAttempts, progress.slots.limit, progress.slots.inUse, progress.slots.queued)}</p>
        <time dateTime={new Date(progress.updatedAt).toISOString()}>{copy.updatedAt}: {new Date(progress.updatedAt).toLocaleTimeString()}</time>
        <p>{copy.attemptCount(progress.attempts.length, progress.outcomeCount ?? progress.attempts.length)}</p>
        <div className="workflow-table-scroll" role="region" tabIndex={0} aria-label={copy.attemptCount(progress.attempts.length, progress.outcomeCount ?? progress.attempts.length)}>
        <table><thead><tr>{copy.attemptColumns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{progress.attempts.map(attempt => <tr key={attempt.attemptId}>
          <td>{attempt.nodeId}</td><td>{copy.roles[attempt.role]}</td><td>{attempt.providerId}</td><td>{copy.attemptStatus[attempt.state]}</td>
          <td>{copy.modelEvidence(attempt.requestedModel?.id ?? copy.defaultModel, attempt.actualModel)}</td>
          <td><code>{attempt.archiveRef ?? attempt.runId ?? copy.unavailable}</code></td>
          <td><WorkflowNodeStopButton workflowId={progress.workflowId} target={{ kind: 'attempt', id: attempt.attemptId }} nodeId={attempt.nodeId}
            settled={attempt.settled} stopRequested={attempt.stopRequested} onChanged={read} />
            {inspectButton(progress.workflowId, progress.programRevision, attempt.nodeId, attempt.frameId)}</td>
        </tr>)}</tbody></table>
        </div>
        {Boolean(progress.systemSteps?.length) && <>
          <h4>{copy.systemResults}</h4>
          <div className="workflow-table-scroll" role="region" tabIndex={0} aria-label={copy.systemResults}>
          <table><thead><tr>{copy.systemColumns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{progress.systemSteps!.map(step => <tr key={step.stepId} data-workflow-system-step={step.nodeId}>
            <td>{step.nodeId}</td><td>{copy.systemKind[step.kind]}</td><td>{copy.systemState[step.state]}</td>
            <td>{step.result ? copy.checkState[step.result.state] : copy.unavailable}</td><td>{step.result?.exitCode ?? copy.unavailable}</td>
            <td>{step.settled ? copy.scopeClosed : copy.scopeUnconfirmed}</td>
            <td><WorkflowNodeStopButton workflowId={progress.workflowId} target={{ kind: 'system', id: step.stepId }} nodeId={step.nodeId}
              settled={step.settled} stopRequested={step.stopRequested} onChanged={read} />
              {inspectButton(progress.workflowId, progress.programRevision, step.nodeId, step.frameId)}</td>
          </tr>)}</tbody></table>
          </div>
        </>}
        {progress.error && <p role="alert">{progress.error}</p>}
        {progress.finalReportStatus === 'available' && <><h4>{copy.observedResult}</h4><pre>{progress.finalReport}</pre></>}
        {progress.finalReportStatus === 'unavailable' && <p>{copy.finalReportUnavailable}</p>}
        {['queued', 'running', 'unknown'].includes(progress.state) && <button type="button" onClick={() => {
          void window.scry.workflow.stop(progress.workflowId, crypto.randomUUID()).then(accepted => {
            if (!accepted) setError(copy.stopUnavailable)
            read(progress.workflowId)
          }).catch(error => setError(message(error)))
        }}>{progress.state === 'unknown' || progress.stopRequestedAt !== undefined ? copy.stopAgain : copy.stop}</button>}
      </details>)}
    </section>}
  </>
}
