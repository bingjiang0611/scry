import { useId, useMemo, useRef, useState } from 'react'
import type { WorkflowPlanPreview, WorkflowProgress, WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import type { WorkflowCapturedTask } from '@shared/workflow-api'
import { parseWorkflowRunCommand } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY as copy, WORKFLOW_TEMPLATE_COPY as templateCopy } from '../constants/copy'
import { WorkflowSizePreference, WorkflowRecordedSize } from './WorkflowSizePreference'
import { WorkflowRolePicker } from './WorkflowRolePicker'
import { WorkflowSystemPlan } from './WorkflowSystemPlan'
import { ModalFrame } from './Modals'
import './workflow.css'

export interface WorkflowLaunchRequest {
  id: string
  command: string
  cwd: string
  orchestrator: WorkflowRoleBinding
  preview?: WorkflowPlanPreview
  fixedTemplate?: boolean
  submission?: WorkflowCapturedTask
}
export const workflowLaunchRequest = (preview: WorkflowPlanPreview): WorkflowLaunchRequest => ({ id: crypto.randomUUID(), command: preview.program.template ? preview.userGoal : `/scry-workflow run ${preview.userGoal}`, cwd: preview.workspace, orchestrator: preview.orchestrator, preview, fixedTemplate: Boolean(preview.program.template) })
const roles: WorkflowRole[] = ['orchestrator', 'worker', 'reviewer', 'summarizer']
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function WorkflowLaunchDialog({ request, agents, onDismiss, onStarted, onError, onEdit }: {
  request: WorkflowLaunchRequest
  agents: DetectedAgent[]
  onDismiss: () => void
  onStarted: (progress: WorkflowProgress) => void
  onError: (error: string) => void
  onEdit: (preview: WorkflowPlanPreview) => void
}) {
  const labelId = useId()
  const [goal, setGoal] = useState(() => request.preview?.userGoal ?? parseWorkflowRunCommand(request.command)?.goal ?? '')
  const [reviewOpen, setReviewOpen] = useState(true)
  const [bindings, setBindings] = useState(() => roles.map(role => {
    const frozen = request.preview?.program.roles.find(binding => binding.role === role) ?? request.orchestrator
    const { runtimeIdentity: _identity, ...input } = frozen
    return { ...input, role }
  }))
  const [ready, setReady] = useState<Partial<Record<WorkflowRole, boolean>>>({})
  const [sizeReady, setSizeReady] = useState(false)
  const [preview, setPreview] = useState<WorkflowPlanPreview | null>(request.preview ?? null)
  const programText = useMemo(() => preview ? JSON.stringify(preview.program.body, null, 2) : '', [preview])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'plan' | 'start' | null>(null)
  const [planningStarted, setPlanningStarted] = useState(false)
  const inFlight = useRef(false)
  const planId = useRef(request.submission?.planningCommandId ?? request.id)
  const startId = useRef(crypto.randomUUID())
  const generate = async () => {
    if (inFlight.current || request.fixedTemplate) return
    inFlight.current = true
    setPlanningStarted(true)
    setBusy('plan'); setError(null); setReviewOpen(false)
    try {
      const next = await window.scry.workflow.plan({ command: request.submission ? request.command : `/scry-workflow run ${goal.trim()}`, commandId: planId.current, cwd: request.cwd,
        ...(request.submission ? { submission: request.submission.reference } : {}), orchestrator: bindings[0], roles: bindings.slice(1) })
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
      void window.scry.workflow.cancelPlanning(planId.current, request.submission?.reference).catch(error => setError(message(error)))
    }}>{copy.cancelPlanning}</button> : <>
      <button type="button" data-workflow-action="review" onClick={() => setReviewOpen(true)}>{preview ? copy.viewPlan : copy.configure}</button>
      <button type="button" onClick={onDismiss}>{copy.cancel}</button>
    </>}
  </aside>
  return <ModalFrame labelledBy={labelId} className="workflow-modal" onClose={() => { if (!busy) onDismiss() }}>
    <h2 id={labelId}>{preview ? copy.planReady : copy.configure}</h2>
    {preview ? <p>{goal}</p> : <label className="workflow-goal">{copy.goal}<textarea value={goal} rows={2} placeholder={copy.goalPlaceholder} disabled={Boolean(busy) || Boolean(request.submission)}
      onChange={event => { setGoal(event.target.value); if (!request.submission) planId.current = crypto.randomUUID() }} /></label>}
    <p>{copy.workspace}: {request.cwd}</p>
    {!preview ? <>
      <p>{copy.planningNotice}</p>
      {request.submission ? request.submission.size.state === 'available' ? <WorkflowRecordedSize value={{ snapshot: request.submission.size.snapshot }} /> : <p role="alert">{request.submission.size.reason}</p> : <WorkflowSizePreference onReady={setSizeReady} onChanged={() => { planId.current = crypto.randomUUID() }} />}
      {bindings.map(binding => <WorkflowRolePicker key={binding.role} binding={binding} agents={agents} cwd={request.cwd} disabled={Boolean(busy) || Boolean(request.submission && planningStarted)}
        onReady={(role, available) => setReady(current => ({ ...current, [role]: available }))}
        onChange={next => {
          if (!request.submission) planId.current = crypto.randomUUID()
          // Invalidate atomically with the edit, not a later child effect. A new
          // Provider can lack the old native permission even before its read completes.
          setReady(current => ({ ...current, [next.role]: false }))
          setBindings(current => current.map(role => role.role === next.role ? next : role))
        }}  />)}
      <p>{copy.experimental}</p><p>{copy.costNotice}</p>
    </> : <>
      <p>{request.fixedTemplate ? templateCopy.frozenConfirmation : copy.previewNotice}</p>
      <WorkflowRecordedSize value={preview.planningSize} />
      <dl><dt>{copy.revision}</dt><dd>{preview.programRevision}</dd></dl>
      <p>{copy.plannedCalls(preview.plannedCalls)}</p>
      <WorkflowSystemPlan key={preview.programRevision} preview={preview} />
      <p>{copy.updatedAt}: {new Date(preview.observedAt).toLocaleString()}</p>
      <table><tbody>{preview.program.roles.map(binding => <tr key={binding.role}>
        <th>{copy.roles[binding.role]}</th><td>{binding.providerId}</td><td>{binding.agentProfileId}</td>
        <td>{binding.requestedModel?.id ?? copy.defaultModel}</td><td>{binding.permissionMode}</td>
      </tr>)}</tbody></table>
      <p>{copy.budgetNotice}</p><p>{copy.costNotice}</p>{!request.fixedTemplate && <p>{copy.planningFee}</p>}
      {preview.unavailableReasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
      <details><summary>{copy.program}</summary><pre>{programText}</pre></details>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="workflow-actions">
      {!busy && <button type="button" onClick={onDismiss}>{copy.cancel}</button>}
      {preview ? <>
        <button type="button" disabled={Boolean(busy)} onClick={() => onEdit(preview)}>{templateCopy.extract}</button>
        {!request.submission && !request.fixedTemplate && <button type="button" data-workflow-action="reconfigure" disabled={Boolean(busy)} onClick={() => { setPreview(null); planId.current = crypto.randomUUID(); startId.current = crypto.randomUUID() }}>{copy.reconfigure}</button>}
        <button type="button" data-workflow-action="approve" disabled={preview.state !== 'ready' || Boolean(busy)} onClick={() => void start()}>{copy.confirm}</button>
      </> : <button type="button" data-workflow-action="plan" disabled={Boolean(busy) || (!request.submission && !sizeReady) || !goal.trim() || ((!request.submission || !planningStarted) && roles.some(role => !ready[role])) || request.submission?.size.state === 'unavailable'} onClick={() => void generate()}>{busy ? copy.planning : request.submission && planningStarted ? copy.viewPlan : copy.generate}</button>}
    </div>
  </ModalFrame>
}
