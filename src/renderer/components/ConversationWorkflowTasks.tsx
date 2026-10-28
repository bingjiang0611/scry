import { useEffect, useId, useRef, useState } from 'react'
import type { WorkflowTaskInspection, WorkflowTaskPage, WorkflowTaskReference } from '@shared/workflow-api'
import { workflowTaskCopy as copy } from '@shared/constants/workflow-task-copy'
import { WORKFLOW_COPY } from '../constants/copy'
import { ModalFrame } from './Modals'
import { WorkflowRecordedSize } from './WorkflowSizePreference'
import { WorkflowSystemPlan } from './WorkflowSystemPlan'
import type { WorkflowLaunchRequest } from './WorkflowLaunchDialog'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function ConversationWorkflowTasks({ conversationId, onConfigure, onPreview }: {
  conversationId: string
  onConfigure: (task: WorkflowTaskInspection) => void
  onPreview: (request: WorkflowLaunchRequest) => void
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<WorkflowTaskPage>()
  const [inspection, setInspection] = useState<WorkflowTaskInspection>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  const summary = useRef<HTMLElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const inspectionTrigger = useRef<HTMLButtonElement | null>(null)
  const labelId = useId()

  useEffect(() => {
    generation.current++
    pending.current = false
    setOpen(false)
    setPage(undefined)
    setInspection(undefined)
    setError(undefined)
    setBusy(false)
    inspectionTrigger.current = null
    return () => { generation.current++ }
  }, [conversationId])

  const read = async <T,>(operation: () => Promise<T>, apply: (value: T) => void) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    const epoch = generation.current
    try {
      const value = await operation()
      if (epoch !== generation.current) return
      apply(value)
    } catch (error) {
      if (epoch === generation.current) setError(copy.readFailed(message(error)))
    } finally {
      if (epoch === generation.current) { pending.current = false; setBusy(false) }
    }
  }
  const load = (cursor?: string) => read(() => window.scry.workflow.capturedTasks(conversationId, cursor), setPage)
  const inspect = (reference: WorkflowTaskReference) => read(() => window.scry.workflow.inspectTask(reference), setInspection)
  const close = () => {
    generation.current++
    pending.current = false
    setBusy(false)
    setOpen(false)
    setInspection(undefined)
    inspectionTrigger.current = null
  }
  useEffect(() => {
    if (!open || busy || inspection) return
    // Reading disables the clicked row before the dialog mounts. Preserve its
    // identity explicitly rather than asking ModalFrame to restore blurred focus.
    if (inspectionTrigger.current?.isConnected) {
      inspectionTrigger.current.focus()
      inspectionTrigger.current = null
    } else if (!menu.current?.contains(document.activeElement)) {
      menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }
  }, [open, busy, inspection])

  const activate = () => {
    if (!inspection) return
    try {
      if (inspection.outcome.kind === 'configure') onConfigure(inspection)
      else if (inspection.outcome.kind === 'preview') {
        const submission = inspection.submission
        if ('editCommandId' in submission) throw new Error(copy.editMissing)
        const fixedTemplate = 'instanceCommandId' in submission
        onPreview({
          id: 'instanceCommandId' in submission ? submission.instanceCommandId : submission.planningCommandId,
          command: inspection.command, cwd: inspection.workspace, fixedTemplate,
          ...('planningCommandId' in submission ? { submission } : {}),
          orchestrator: inspection.outcome.preview.orchestrator, preview: inspection.outcome.preview
        })
      }
      close()
    } catch (error) { setError(message(error)) }
  }
  const outcome = inspection?.outcome
  const canOpen = outcome?.kind === 'configure' || (outcome?.kind === 'preview' &&
    outcome.progressState === 'awaiting_approval' && outcome.preview.state === 'ready')

  return <>
    <details className="conversation-options conversation-workflow-tasks" open={open} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); summary.current?.focus() }
    }}>
      <summary ref={summary} title={copy.open} onClick={event => {
        event.preventDefault()
        if (open) close()
        else { setOpen(true); void load() }
      }}>{copy.title}</summary>
      <div ref={menu} className="unified-management conversation-task-menu">
        <p>{copy.source}</p>
        <div className="conversation-task-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void load()}>{copy.refresh}</button>
          <button type="button" className="btn" disabled={busy || !page?.nextCursor} onClick={() => void load(page?.nextCursor)}>{copy.more}</button>
        </div>
        {busy && <p role="status">{copy.loading}</p>}
        {error && <p role="alert">{error}</p>}
        {page && <>
          <p>{copy.recordedAt(new Date(page.observedAt).toLocaleString())}</p>
          {page.items.length === 0 && <p>{copy.empty}</p>}
          <ul className="conversation-task-list">{page.items.map(task => <li key={task.submissionId}>
            <button type="button" className="btn" disabled={busy} title={copy.openTask}
              data-workflow-task={task.submissionId} onClick={event => {
                inspectionTrigger.current = event.currentTarget
                void inspect(task.reference)
              }}>
              <span>{copy.identifier(task.submissionId)} · {copy.operations[task.operation]}</span><span>{copy.phases[task.phase]}</span>
            </button>
          </li>)}</ul>
        </>}
      </div>
    </details>
    {inspection && <ModalFrame labelledBy={labelId} className="workflow-modal conversation-task-inspector" onClose={() => setInspection(undefined)}>
      <header><h2 id={labelId}>{copy.title}</h2><button type="button" className="btn" onClick={() => setInspection(undefined)}>{copy.close}</button></header>
      <p>{copy.source}</p>
      <p>{copy.identifier(inspection.task.submissionId)} · {copy.phases[inspection.task.phase]}</p>
      <p>{copy.recordedAt(new Date(inspection.observedAt).toLocaleString())}</p>
      <h3>{copy.originalSubmission}</h3><pre className="conversation-task-input">{inspection.command}</pre>
      {'size' in inspection.submission && inspection.submission.size.state === 'available' &&
        <WorkflowRecordedSize value={{ snapshot: inspection.submission.size.snapshot }} />}
      {outcome?.kind === 'blocked' && <p role="status">{copy.blocked[outcome.reason]}</p>}
      {outcome?.kind === 'preview' && <>
        <p>{copy.observedPlan}</p><p>{copy.workflowState(WORKFLOW_COPY.status[outcome.progressState])}</p>
        <WorkflowSystemPlan preview={outcome.preview} />
        {outcome.preview.unavailableReasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
      </>}
      {error && <p role="alert">{error}</p>}
      {canOpen && <button type="button" className="btn" data-workflow-task-open onClick={activate}>
        {outcome?.kind === 'configure' && 'editCommandId' in inspection.submission ? copy.edit :
          outcome?.kind === 'configure' ? copy.configure : copy.viewPlan}
      </button>}
    </ModalFrame>}
  </>
}
