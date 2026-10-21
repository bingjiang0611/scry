import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentRunControlCatalog } from '@shared/runtime'
import type { CapabilityEnvelope, ProviderContext } from '@shared/provider'
import { providerIdForAgentId } from '@shared/runtime'
import type { WorkflowPlanPreview, WorkflowProgress, WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import { parseWorkflowRunCommand } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY as copy } from '../constants/copy'
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
const modelKey = (model: { id: string; providerId?: string }) => JSON.stringify([model.providerId ?? '', model.id])
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const catalogsInFlight = new Map<string, Promise<CapabilityEnvelope<AgentRunControlCatalog>>>()
function readRoleControls(context: ProviderContext) {
  const read = window.scry.runControls
  if (!read) return Promise.reject(new Error(copy.configurationUnavailable))
  const key = JSON.stringify(context)
  const existing = catalogsInFlight.get(key)
  if (existing) return existing
  if (catalogsInFlight.size >= 128) return Promise.reject(new Error(copy.configurationUnavailable))
  const result = read(context)
  catalogsInFlight.set(key, result)
  const clear = () => { if (catalogsInFlight.get(key) === result) catalogsInFlight.delete(key) }
  void result.then(clear, clear)
  return result
}

export function mergeWorkflowProgress(current: WorkflowProgress[], incoming: WorkflowProgress[]): WorkflowProgress[] {
  const combined = new Map(current.map(progress => [progress.workflowId, progress]))
  for (const progress of incoming) {
    const prior = combined.get(progress.workflowId)
    if (!prior || (prior.revision ?? 0) <= (progress.revision ?? 0)) combined.set(progress.workflowId, progress)
  }
  return [...combined.values()]
}

function RolePicker({ binding, agents, cwd, disabled, onChange, onReady }: {
  binding: WorkflowRoleBinding
  agents: DetectedAgent[]
  cwd: string
  disabled: boolean
  onChange: (binding: WorkflowRoleBinding) => void
  onReady: (role: WorkflowRole, ready: boolean) => void
}) {
  const catalogKey = JSON.stringify([binding.providerId, binding.agentProfileId, cwd])
  const [catalogState, setCatalog] = useState<{ key: string; data: AgentRunControlCatalog } | null>(null)
  const catalog = catalogState?.key === catalogKey ? catalogState.data : null
  const [error, setError] = useState<string | null>(null)
  // Catalog reads are bounded by the four role rows; a stale reply never
  // changes a newer Provider/profile selection.
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  useEffect(() => {
    let current = true
    setCatalog(null)
    setError(null)
    readyRef.current(binding.role, false)
    void readRoleControls({ providerId: binding.providerId, agentProfileId: binding.agentProfileId, cwd }).then(result => {
      if (!current) return
      if (!result.data || result.state !== 'ready') throw new Error(result.reason ?? copy.configurationUnavailable)
      setCatalog({ key: catalogKey, data: result.data })
    }).catch(error => { if (current) setError(message(error)) })
    return () => { current = false }
  }, [binding.role, binding.providerId, binding.agentProfileId, cwd])
  const selected = agents.find(agent => providerIdForAgentId(agent.id) === binding.providerId &&
    (binding.providerId !== 'pi' || agent.id === binding.agentProfileId))?.id ?? ''
  const modelAvailable = Boolean(catalog && (binding.requestedModel
    ? catalog.models.some(option => modelKey(option.model) === modelKey(binding.requestedModel!)) : catalog.models.length > 0))
  const permissionAvailable = Boolean(catalog?.permissions.some(option => option.id === (binding.permissionMode ?? 'default')))
  const valid = Boolean(selected && modelAvailable && permissionAvailable)
  useEffect(() => { readyRef.current(binding.role, valid) }, [binding.role, binding.providerId, binding.agentProfileId,
    binding.requestedModel?.id, binding.requestedModel?.providerId, binding.permissionMode, valid])
  return <fieldset className="workflow-role" data-workflow-role={binding.role} disabled={disabled}>
    <legend>{copy.roles[binding.role]}</legend>
    <label>{copy.provider}<select value={selected} onChange={event => {
      const agent = agents.find(candidate => candidate.id === event.target.value)
      const providerId = agent && providerIdForAgentId(agent.id)
      if (!agent || !providerId) return
      onChange({ role: binding.role, providerId, ...(providerId === 'pi' ? { agentProfileId: agent.id } : {}), permissionMode: 'default' })
    }}>
      {!selected && <option value="" disabled>{copy.emptyAgents}</option>}
      {agents.map(agent => <option key={agent.id} value={agent.id} disabled={Boolean(agent.unavailableReason) || !providerIdForAgentId(agent.id)}>{agent.name}</option>)}
    </select></label>
    <label>{copy.model}<select disabled={!catalog} value={binding.requestedModel ? modelKey(binding.requestedModel) : ''} onChange={event => {
      const model = catalog?.models.find(option => modelKey(option.model) === event.target.value)?.model
      onChange({ ...binding, requestedModel: model })
    }}>
      {binding.requestedModel && !modelAvailable && <option value={modelKey(binding.requestedModel)} disabled>{copy.selectedModelUnavailable}</option>}
      <option value="">{catalog ? copy.providerDefault : copy.loading}</option>
      {catalog?.models.map(option => <option key={modelKey(option.model)} value={modelKey(option.model)}>{option.label}</option>)}
    </select></label>
    <label>{copy.permission}<select disabled={!catalog} value={binding.permissionMode ?? 'default'} onChange={event => {
      const permissionMode = catalog?.permissions.find(option => option.id === event.target.value)?.id
      if (permissionMode) onChange({ ...binding, permissionMode })
    }}>
      {!permissionAvailable && <option value={binding.permissionMode ?? 'default'} disabled>{catalog ? copy.selectedPermissionUnavailable : copy.loading}</option>}
      {catalog?.permissions.map(option => <option key={option.id} value={option.id} title={option.description}>{option.label}</option>)}
    </select></label>
    {catalog && <p>{catalog.permissions.find(option => option.id === (binding.permissionMode ?? 'default'))?.description}</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>
}

function Launch({ request, agents, onDismiss, onStarted, onError }: {
  request: WorkflowLaunchRequest
  agents: DetectedAgent[]
  onDismiss: () => void
  onStarted: (progress: WorkflowProgress) => void
  onError: (error: string) => void
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
      {bindings.map(binding => <RolePicker key={binding.role} binding={binding} agents={agents} cwd={request.cwd} disabled={Boolean(busy)}
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
    {cwd && onNew && <button className="workflow-entry" type="button" onClick={onNew} title={copy.commandHint}>{copy.title}</button>}
    {activeRequest && <Launch key={activeRequest.id} request={activeRequest} agents={agents}
      onDismiss={() => { previewEpoch.current++; setRestored(null); onDismiss() }} onStarted={observe} onError={setError} />}
    {(progresses.length > 0 || error || nextCursor || unresolvedPlanning > 0) && <section className="workflow-progress" aria-label={copy.title}>
      {error && <p role="alert">{error}</p>}
      {unresolvedPlanning > 0 && <p role="alert">{copy.unresolvedPlanning(unresolvedPlanning)}</p>}
      {nextCursor && <button disabled={loadingHistory} type="button" onClick={() => loadHistory(nextCursor)}>{copy.loadMore}</button>}
      {progresses.map(progress => <details key={progress.workflowId} data-workflow-id={progress.workflowId}>
        <summary>{progress.goal} · {progress.stopRequestedAt !== undefined && ['queued', 'running'].includes(progress.state) ? copy.stopPending : copy.status[progress.state]}</summary>
        <code>{progress.workflowId}</code>
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
