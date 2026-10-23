import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { WorkflowRolePicker } from './WorkflowRolePicker'
import type { WorkflowPlanPreview, WorkflowProgress, WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import { parseWorkflowRunCommand } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY as copy, WORKFLOW_TEMPLATE_COPY as templateCopy } from '../constants/copy'
import { WorkflowTemplateWorkbench } from './WorkflowTemplateWorkbench'
import { ModalFrame } from './Modals'
import './workflow.css'

export interface WorkflowLaunchRequest {
  id: string
  command: string
  cwd: string
  orchestrator: WorkflowRoleBinding
  preview?: WorkflowPlanPreview
}
const roles: WorkflowRole[] = ['orchestrator', 'worker', 'reviewer', 'summarizer']
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


function Launch({ request, agents, onDismiss, onStarted, onError, onEdit }: {
  request: WorkflowLaunchRequest
  agents: DetectedAgent[]
  onDismiss: () => void
  onStarted: (progress: WorkflowProgress) => void
  onError: (error: string) => void
  onEdit: (preview: WorkflowPlanPreview) => void
}) {
  const labelId = useId()
  const [goal, setGoal] = useState(() => parseWorkflowRunCommand(request.command)?.goal ?? '')
  const [reviewOpen, setReviewOpen] = useState(true)
  const [bindings, setBindings] = useState(() => roles.map(role => {
    const frozen = request.preview?.program.roles.find(binding => binding.role === role) ?? request.orchestrator
    const { runtimeIdentity: _identity, ...input } = frozen
    return { ...input, role }
  }))
  const [ready, setReady] = useState<Partial<Record<WorkflowRole, boolean>>>({})
  const [preview, setPreview] = useState<WorkflowPlanPreview | null>(request.preview ?? null)
  const programText = useMemo(() => preview ? JSON.stringify(preview.program.body, null, 2) : '', [preview])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'plan' | 'start' | null>(null)
  const inFlight = useRef(false)
  const planId = useRef(request.id)
  const startId = useRef(crypto.randomUUID())
  const generate = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('plan'); setError(null); setReviewOpen(false)
    try {
      const next = await window.scry.workflow.plan({ command: `/scry-workflow run ${goal.trim()}`, commandId: planId.current, cwd: request.cwd,
        orchestrator: bindings[0], roles: bindings.slice(1) })
      setPreview(next)
    } catch (error) { setError(message(error)) }
    finally { inFlight.current = false; setBusy(null) }
  }
  const start = async () => {
    if (!preview || preview.state !== 'ready' || inFlight.current) return
    inFlight.current = true
    setBusy('start'); setError(null)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: Date.now() }
    try {
      await window.scry.workflow.approve(approval)
      // Consume the authoritative terminal/unknown response as well as live
      // events. Reading before start raced with registration and showed a draft.
      void window.scry.workflow.start(preview.workflowId, approval, startId.current).then(onStarted).catch(error => onError(message(error)))
      onDismiss()
    } catch (error) { setError(message(error)); inFlight.current = false; setBusy(null) }
  }
  if (!reviewOpen) return <aside className="workflow-planning" aria-live="polite">
    <p>{goal} · {busy ? copy.planning : preview ? copy.planReady : copy.unavailable}</p>
    <p>{copy.workspace}: {request.cwd}</p>
    {error && <p role="alert">{error}</p>}
    {busy === 'plan' ? <button type="button" onClick={() => {
      void window.scry.workflow.cancelPlanning(planId.current).catch(error => setError(message(error)))
    }}>{copy.cancelPlanning}</button> : <>
      <button type="button" data-workflow-action="review" onClick={() => setReviewOpen(true)}>{preview ? copy.viewPlan : copy.configure}</button>
      <button type="button" onClick={onDismiss}>{copy.cancel}</button>
    </>}
  </aside>
  return <ModalFrame labelledBy={labelId} className="workflow-modal" onClose={() => { if (!busy) onDismiss() }}>
    <h2 id={labelId}>{preview ? copy.planReady : copy.configure}</h2>
    {preview ? <p>{goal}</p> : <label className="workflow-goal">{copy.goal}<textarea value={goal} rows={2} placeholder={copy.goalPlaceholder} disabled={Boolean(busy)}
      onChange={event => { setGoal(event.target.value); planId.current = crypto.randomUUID() }} /></label>}
    <p>{copy.workspace}: {request.cwd}</p>
    {!preview ? <>
      <p>{copy.planningNotice}</p>
      {bindings.map(binding => <WorkflowRolePicker key={binding.role} binding={binding} agents={agents} cwd={request.cwd} disabled={Boolean(busy)}
        onReady={(role, available) => setReady(current => ({ ...current, [role]: available }))}
        onChange={next => {
          planId.current = crypto.randomUUID()
          // Invalidate atomically with the edit, not a later child effect. A new
          // Provider can lack the old native permission even before its read completes.
          setReady(current => ({ ...current, [next.role]: false }))
          setBindings(current => current.map(role => role.role === next.role ? next : role))
        }}  />)}
      <p>{copy.experimental}</p><p>{copy.costNotice}</p>
    </> : <>
      <p>{copy.previewNotice}</p>
      <dl><dt>{copy.revision}</dt><dd>{preview.programRevision}</dd></dl>
      <p>{copy.plannedCalls(preview.plannedCalls)}</p>
      <p>{copy.updatedAt}: {new Date(preview.observedAt).toLocaleString()}</p>
      <table><tbody>{preview.program.roles.map(binding => <tr key={binding.role}>
        <th>{copy.roles[binding.role]}</th><td>{binding.providerId}</td><td>{binding.agentProfileId}</td>
        <td>{binding.requestedModel?.id ?? copy.defaultModel}</td><td>{binding.permissionMode}</td>
      </tr>)}</tbody></table>
      <p>{copy.budgetNotice}</p><p>{copy.costNotice}</p><p>{copy.planningFee}</p>
      {preview.unavailableReasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
      <details><summary>{copy.program}</summary><pre>{programText}</pre></details>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="workflow-actions">
      {!busy && <button type="button" onClick={onDismiss}>{copy.cancel}</button>}
      {preview ? <>
        <button type="button" disabled={Boolean(busy)} onClick={() => onEdit(preview)}>{templateCopy.extract}</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => { setPreview(null); planId.current = crypto.randomUUID(); startId.current = crypto.randomUUID() }}>{copy.reconfigure}</button>
        <button type="button" data-workflow-action="approve" disabled={preview.state !== 'ready' || Boolean(busy)} onClick={() => void start()}>{copy.confirm}</button>
      </> : <button type="button" data-workflow-action="plan" disabled={Boolean(busy) || !goal.trim() || roles.some(role => !ready[role])} onClick={() => void generate()}>{busy ? copy.planning : copy.generate}</button>}
    </div>
  </ModalFrame>
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
  const launchPreview = (preview: WorkflowPlanPreview): WorkflowLaunchRequest => ({ id: crypto.randomUUID(), command: `/scry-workflow run ${preview.userGoal}`, cwd: preview.workspace, orchestrator: preview.orchestrator, preview })
  const previewEpoch = useRef(0)
  useEffect(() => { if (request) { previewEpoch.current++; setRestored(null) } }, [request?.id])
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
    setRecent([]); setHistory([]); setRestored(null); setNextCursor(undefined); setUnresolvedPlanning(0); setError(null)
    previewEpoch.current++
    loadHistory()
    return () => { historyEpoch.current++; previewEpoch.current++ }
  }, [cwd])
  const read = (id: string) => { void window.scry.workflow.snapshot(id).then(progress => {
    if (progress) observe(progress)
    else setError(copy.missingSnapshot)
  }).catch(error => setError(copy.snapshotError(message(error)))) }
  return <>
    {cwd && <div className="workflow-entry-actions">
      <button className="workflow-entry" type="button" onClick={() => setWorkbench({ id: crypto.randomUUID(), cwd })}>{templateCopy.title}</button>
      {onNew && <button className="workflow-entry" type="button" onClick={onNew} title={copy.commandHint}>{copy.title}</button>}
    </div>}
    {activeRequest && !workbench && <Launch key={activeRequest.id} request={activeRequest} agents={agents}
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
        <table><thead><tr>{copy.attemptColumns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{progress.attempts.map(attempt => <tr key={attempt.attemptId}>
          <td>{attempt.nodeId}</td><td>{copy.roles[attempt.role]}</td><td>{attempt.providerId}</td><td>{copy.attemptStatus[attempt.state]}</td>
          <td>{copy.modelEvidence(attempt.requestedModel?.id ?? copy.defaultModel, attempt.actualModel)}</td>
          <td><code>{attempt.archiveRef ?? attempt.runId ?? copy.unavailable}</code></td>
        </tr>)}</tbody></table>
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
