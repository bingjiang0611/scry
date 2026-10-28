import { useEffect, useId, useRef, useState } from 'react'
import type { WorkflowCapturedTemplateTask } from '@shared/workflow-api'
import type { WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY, WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'
import { WorkflowProviderSelect, WorkflowRolePicker } from './WorkflowRolePicker'
import type { WorkflowLaunchRequest } from './WorkflowLaunchDialog'
import { ModalFrame } from './Modals'

export type WorkflowTemplatePreparationRequest = {
  command: string
  cwd: string
  submission: WorkflowCapturedTemplateTask
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function WorkflowTemplateTaskDialog({ request, agents, onDismiss, onPrepared }: {
  request: WorkflowTemplatePreparationRequest
  agents: DetectedAgent[]
  onDismiss: () => void
  onPrepared: (request: WorkflowLaunchRequest) => void
}) {
  const labelId = useId()
  const [bindings, setBindings] = useState<Partial<Record<WorkflowRole, WorkflowRoleBinding>>>({})
  const [ready, setReady] = useState<Partial<Record<WorkflowRole, boolean>>>({})
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string>()
  const cancelButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const pending = useRef(false)
  const cancelled = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const template = request.submission.template
  const roles = template.state === 'available' ? template.roles : []
  const change = (binding: WorkflowRoleBinding) => {
    setReady(current => ({ ...current, [binding.role]: false }))
    setBindings(current => ({ ...current, [binding.role]: binding }))
  }
  const prepare = async () => {
    const orchestrator = bindings.orchestrator
    if (!orchestrator || pending.current || cancelled.current || roles.some(role => !bindings[role] || !ready[role])) return
    pending.current = true
    // The clicked prepare control becomes disabled. Keep focus inside the modal
    // so Escape still reaches its owner while preparation is pending.
    cancelButton.current?.focus()
    setStarted(true); setBusy(true); setError(undefined)
    try {
      const preview = await window.scry.workflow.prepareTemplateTask({
        reference: request.submission.reference, orchestrator,
        roles: roles.filter(role => role !== 'orchestrator').map(role => bindings[role]!)
      })
      if (mounted.current && !cancelled.current) onPrepared({
        id: request.submission.instanceCommandId, command: request.command, cwd: request.cwd,
        orchestrator: preview.orchestrator, preview, fixedTemplate: true
      })
    } catch (error) { if (mounted.current && !cancelled.current) setError(message(error)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const dismiss = async () => {
    if (closing) return
    if (!started) { onDismiss(); return }
    cancelled.current = true
    setClosing(true); setError(undefined)
    try {
      // ACK fences further preparation; it does not claim physical settlement.
      await window.scry.workflow.cancelPlanning(request.submission.instanceCommandId, request.submission.reference)
      if (mounted.current) onDismiss()
    } catch (error) { if (mounted.current) setError(message(error)) }
    finally { if (mounted.current) setClosing(false) }
  }
  return <ModalFrame labelledBy={labelId} className="workflow-modal" onClose={() => { void dismiss() }}>
    <h2 id={labelId}>{copy.bind}</h2>
    <p>{WORKFLOW_COPY.workspace}: {request.cwd}</p>
    <p>{copy.sourceIdentity(copy.scopes[template.ref.scope.kind], template.ref.templateId)}</p>
    <p>{copy.revision}: {template.ref.revisionHash}</p>
    <pre className="conversation-task-input">{request.command}</pre>
    {template.state === 'unavailable' ? <p role="alert">{template.reason}</p> : <>
      <h3>{template.name}</h3>
      {roles.map(role => bindings[role] ? <WorkflowRolePicker key={role} binding={bindings[role]!}
        agents={agents} cwd={request.cwd} disabled={started}
        onChange={change} onReady={(role, available) => setReady(current => ({ ...current, [role]: available }))} />
        : <fieldset key={role} className="workflow-role" data-workflow-role={role} disabled={started}>
          <legend>{WORKFLOW_COPY.roles[role]}</legend>
          <WorkflowProviderSelect role={role} agents={agents} onChange={change} />
        </fieldset>)}
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="workflow-actions">
      <button ref={cancelButton} type="button" disabled={closing} onClick={() => void dismiss()}>{copy.cancel}</button>
      <button type="button" data-workflow-action="prepare-template" disabled={busy || closing || cancelled.current ||
        template.state !== 'available' || roles.some(role => !bindings[role] || !ready[role])}
        onClick={() => void prepare()}>{busy ? copy.busy : copy.prepare}</button>
    </div>
  </ModalFrame>
}
