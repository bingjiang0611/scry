import { useRef, useState } from 'react'
import type { WorkflowRoleBinding } from '@shared/workflow'
import type { WorkflowTaskReference, WorkflowTemplateEditTaskInspection } from '@shared/workflow-api'
import type { WorkflowTemplateEditCandidateAttemptSummary, WorkflowTemplateEditCandidateInspection, WorkflowTemplateSnapshot } from '@shared/workflow-template'
import { providerIdForAgentId } from '@shared/runtime'
import { workflowTemplateEditCopy as copy } from '@shared/constants/workflow-template-edit-copy'
import type { DetectedAgent } from '../env'
import { WORKFLOW_TEMPLATE_COPY as templateCopy } from '../constants/copy'
import { templateSourceDifference } from '../workflow-template-review'
import { WorkflowRolePicker } from './WorkflowRolePicker'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const summarize = (attempt: WorkflowTemplateEditCandidateInspection): WorkflowTemplateEditCandidateAttemptSummary => {
  if (attempt.state.kind !== 'candidate') return attempt
  const { source: _source, ...state } = attempt.state
  return { ...attempt, state }
}
export type WorkflowTemplateEditCandidateTask = { reference: WorkflowTaskReference; revision: number
  selection: { kind: 'unselected' } | { kind: 'saved'; ref: import('@shared/workflow-template').WorkflowTemplateRef }
  authoring?: Extract<WorkflowTemplateEditTaskInspection['authoring'], { state: 'available' }> }

export function WorkflowTemplateEditCandidatePanel({ task, snapshot, current, agents, cwd, orchestrator, disabled, onDraft }: {
  task: WorkflowTemplateEditCandidateTask
  snapshot?: WorkflowTemplateSnapshot
  current: WorkflowTemplateSnapshot | null
  agents: DetectedAgent[]
  cwd: string
  orchestrator?: WorkflowRoleBinding
  disabled: boolean
  onDraft: (draft: import('@shared/workflow-template').WorkflowTemplateDraft) => void
}) {
  const selectedAgent = agents.find(agent => !agent.unavailableReason && providerIdForAgentId(agent.id))
  const seed = orchestrator ? { ...orchestrator, permissionMode: 'default' as const } : (selectedAgent ? { role: 'orchestrator' as const, providerId: providerIdForAgentId(selectedAgent.id)!,
    ...(providerIdForAgentId(selectedAgent.id) === 'pi' ? { agentProfileId: selectedAgent.id } : {}), permissionMode: 'default' as const } : null)
  const [author, setAuthor] = useState<WorkflowRoleBinding | null>(seed), [ready, setReady] = useState(false)
  const [confirmed, setConfirmed] = useState(false), [attempt, setAttempt] = useState<WorkflowTemplateEditCandidateInspection | undefined>(task.authoring?.attempt)
  const [history, setHistory] = useState(task.authoring?.history ?? [])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const [destination, setDestination] = useState<'personal' | 'project'>('personal'), [applyConfirmed, setApplyConfirmed] = useState(false)
  const priorApplication = task.authoring?.applications.find(item => item.state.kind === 'applied') ?? task.authoring?.applications[0]
  const [application, setApplication] = useState<'unknown' | 'applied' | undefined>(priorApplication?.state.kind === 'applied' ? 'applied' : priorApplication?.state.kind === 'unknown' ? 'unknown' : undefined)
  const [applyBusy, setApplyBusy] = useState(false), [applyError, setApplyError] = useState<string | undefined>(priorApplication?.state.kind === 'unknown' ? priorApplication.state.reason : undefined)
  const attemptId = useRef<string | undefined>(undefined), applicationId = useRef<string | undefined>(undefined)
  const sourceMatches = Boolean(snapshot && current && JSON.stringify(snapshot.ref) === JSON.stringify(current.ref))
  const difference = attempt?.state.kind === 'candidate' && snapshot ? templateSourceDifference(snapshot.source, attempt.state.source) : null
  const request = async () => {
    if (!snapshot || !author || !ready || !confirmed || attempt || busy || !sourceMatches) return
    attemptId.current ??= crypto.randomUUID()
    const { providerId, agentProfileId, requestedModel } = author
    setBusy(true); setError(undefined)
    try {
      const next = await window.scry.workflow.requestTemplateEditCandidate({ reference: task.reference, expectedTaskRevision: task.revision,
        attemptId: attemptId.current, author: { providerId, ...(agentProfileId ? { agentProfileId } : {}), ...(requestedModel ? { requestedModel } : {}) },
        ...(task.selection.kind === 'unselected' ? { selection: snapshot.ref } : {}),
        disclosure: { acknowledgesModelCall: true, acknowledgesSourceDisclosure: true } })
      setAttempt(next); setHistory(previous => [summarize(next), ...previous.filter(item => item.attemptId !== next.attemptId)])
    } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  const retry = () => {
    setAttempt(undefined); attemptId.current = undefined; setConfirmed(false); setApplication(undefined); applicationId.current = undefined
    setApplyConfirmed(false); setError(undefined); setApplyError(undefined)
  }
  const retryApplication = () => { setApplication(undefined); applicationId.current = undefined; setApplyConfirmed(false); setApplyError(undefined) }
  const apply = async () => {
    if (!attempt || attempt.state.kind !== 'candidate' || !applyConfirmed || application || applyBusy) return
    applicationId.current ??= crypto.randomUUID()
    setApplyBusy(true); setApplyError(undefined)
    try {
      const result = await window.scry.workflow.applyTemplateEditCandidate({ reference: task.reference, expectedTaskRevision: task.revision,
        attemptId: attempt.attemptId, commandId: applicationId.current, destination })
      if (result.state === 'applied') { setApplication('applied'); onDraft(result.draft) }
      else { setApplication('unknown'); setApplyError(result.reason) }
    } catch (error) { setApplyError(message(error)) } finally { setApplyBusy(false) }
  }
  if (!snapshot) return <section aria-label={copy.authoringTitle}><h3>{copy.authoringTitle}</h3><p>{copy.authoringUnavailable}</p></section>
  return <section className="workflow-template-authoring" aria-label={copy.authoringTitle}><h3>{copy.authoringTitle}</h3>
    <p>{copy.authoringSends}</p><p>{copy.authoringExcludes}</p><p>{copy.authoringCost}</p><p>{copy.authoringBoundary}</p>
    {!sourceMatches ? <p>{copy.authoringDifferentSource}</p> : <>
      {history.length > 0 && <details><summary>{copy.authoringHistory} ({history.length})</summary><ol>{history.map(item =>
        <li key={item.attemptId}><code>{item.attemptId}</code> — {item.state.kind}</li>)}</ol></details>}
      {author && !attempt && <WorkflowRolePicker binding={author} agents={agents} cwd={cwd} disabled={disabled || busy} lockDefaultPermission
        onChange={next => { setAuthor({ ...next, permissionMode: 'default' }); setReady(false); setConfirmed(false) }} onReady={(_role, value) => setReady(value)} />}
      {!attempt && <><label><input type="checkbox" checked={confirmed} disabled={disabled || busy || !ready} onChange={event => setConfirmed(event.target.checked)} />{copy.authoringConfirm}</label>
        <button type="button" disabled={disabled || busy || !author || !ready || !confirmed} onClick={() => void request()}>{copy.authoringAction}</button></>}
      {error && <p role="alert">{error}</p>}
      {attempt?.state.kind === 'dispatch_intent' && <p role="status">{copy.authoringIntent}</p>}
      {attempt?.state.kind === 'unknown' && <><p role="alert">{copy.authoringUnknown} {attempt.state.reason}</p><button type="button" data-template-candidate-retry disabled={disabled || busy} onClick={retry}>{copy.authoringRetry}</button></>}
      {attempt?.state.kind === 'candidate' && <section aria-label={copy.authoringCandidate}><h4>{copy.authoringCandidate}</h4>
        <p>{copy.authoringTask}: {attempt.taskRevision} · Provider: <code>{attempt.author.providerId}</code> · {copy.authoringRequestedModel}: <code>{attempt.author.requestedModel?.id ?? copy.authoringNoModel}</code> · {copy.authoringActualModel}: <code>{attempt.state.actualModel ?? copy.authoringNoModel}</code></p>
        <p>{copy.authoringArchive}: <code>{attempt.state.archiveRef}</code></p><p>{copy.authoringSummary}: {attempt.state.summary}</p>
        {attempt.state.validation.state === 'invalid' && <p role="alert">{copy.authoringInvalid} {attempt.state.validation.error}</p>}
        {difference && <><p>{templateCopy.difference(difference.removedLines, difference.addedLines)}</p><div className="workflow-template-editor-grid"><label>{templateCopy.before}<textarea aria-label={templateCopy.before} readOnly value={snapshot.source} /></label><label>{templateCopy.after}<textarea aria-label={templateCopy.after} readOnly value={attempt.state.source} /></label></div></>}
        <p>{copy.applyBoundary}</p>
        {!application && <><label>{copy.applyDestination}<select value={destination} disabled={disabled || applyBusy} onChange={event => { setDestination(event.target.value as 'personal' | 'project'); setApplyConfirmed(false) }}><option value="personal">{copy.applyPersonal}</option><option value="project">{copy.applyProject}</option></select></label>
          <label><input type="checkbox" checked={applyConfirmed} disabled={disabled || applyBusy} onChange={event => setApplyConfirmed(event.target.checked)} />{copy.applyConfirm}</label>
          <button type="button" data-template-candidate-apply disabled={disabled || applyBusy || !applyConfirmed} onClick={() => void apply()}>{copy.applyAction}</button></>}
        {task.authoring && task.authoring.applications.length > 0 && <details><summary>{copy.applyHistory} ({task.authoring.applications.length})</summary><ol>{task.authoring.applications.map(item =>
          <li key={item.commandId}><code>{item.commandId}</code> — {item.state.kind}</li>)}</ol></details>}
        {application === 'applied' && <p role="status">{copy.applyAlready}</p>}
        {application === 'unknown' && <><p role="alert">{copy.applyUnknown} {applyError}</p><button type="button" onClick={retryApplication}>{copy.applyRetry}</button></>}
        {!application && applyError && <p role="alert">{applyError}</p>}
        {application !== 'unknown' && <button type="button" data-template-candidate-retry disabled={disabled || applyBusy} onClick={retry}>{copy.authoringRetry}</button>}
      </section>}
    </>}
  </section>
}
