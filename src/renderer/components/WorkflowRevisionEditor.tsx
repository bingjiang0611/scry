import { useEffect, useId, useRef, useState } from 'react'
import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress } from '@shared/workflow'
import { WORKFLOW_COPY as workflowCopy, WORKFLOW_REVISION_COPY as copy } from '../constants/copy'
import { workflowRevisionDraft, workflowRevisionSource } from '../workflow-revision-editor'
import { ModalFrame } from './Modals'
import { WorkflowSystemPlan } from './WorkflowSystemPlan'

export function WorkflowRevisionEditor({ workflowId, onClose, onStarted }: {
  workflowId: string
  onClose: () => void
  onStarted: (progress: WorkflowProgress) => void
}) {
  const titleId = useId()
  const [loaded, setLoaded] = useState<{ preview: WorkflowPlanPreview; expectedRevision: number } | null>(null)
  const [source, setSource] = useState('')
  const [candidate, setCandidate] = useState<WorkflowPlanPreview | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'execute' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const commandId = useRef<string>()
  const executionApproval = useRef<WorkflowApproval>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void Promise.all([window.scry.workflow.preview(workflowId), window.scry.workflow.snapshot(workflowId)]).then(([preview, progress]) => {
      if (!mounted.current) return
      if (!progress?.revision || preview.programRevision !== progress.programRevision ||
        !['completed', 'failed', 'stopped', 'blocked'].includes(progress.state)) throw new Error(copy.stale)
      setLoaded({ preview, expectedRevision: progress.revision })
      setSource(workflowRevisionSource(preview))
    }).catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) })
    return () => { mounted.current = false }
  }, [workflowId])

  const prepare = async () => {
    if (!loaded || inFlight.current) return
    inFlight.current = true
    setBusy('prepare'); setError(null)
    try {
      const draft = workflowRevisionDraft(workflowId, loaded.expectedRevision, source)
      const preview = await window.scry.workflow.prepareRevision(draft)
      if (mounted.current) { setCandidate(preview); commandId.current = crypto.randomUUID(); executionApproval.current = undefined }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { inFlight.current = false; if (mounted.current) setBusy(null) }
  }
  const execute = async () => {
    if (!loaded || !candidate || candidate.state !== 'ready' || !commandId.current || inFlight.current) return
    inFlight.current = true
    setBusy('execute'); setError(null)
    const approval = executionApproval.current ??= { workflowId, programRevision: candidate.programRevision, approvedAt: Date.now() }
    try {
      const progress = await window.scry.workflow.revise(workflowId, approval, { expectedRevision: loaded.expectedRevision }, commandId.current)
      onStarted(progress)
      if (mounted.current) onClose()
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { inFlight.current = false; if (mounted.current) setBusy(null) }
  }

  return <ModalFrame labelledBy={titleId} className="workflow-modal workflow-revision-editor" onClose={onClose}>
    <h2 id={titleId}>{copy.title}</h2>
    <p>{copy.notice}</p>
    {loaded?.preview.program.template && <p>{copy.templateNotice}</p>}
    {error && <p role="alert">{error}</p>}
    {!loaded && !error && <p role="status">{copy.loading}</p>}
    {loaded && <>
      <p>{copy.expectedRevision(loaded.expectedRevision)}</p>
      {candidate ? <section aria-label={copy.review}>
        <h3>{copy.review}</h3>
        <dl><dt>{workflowCopy.workspace}</dt><dd><code>{candidate.workspace}</code></dd>
          <dt>{workflowCopy.revision}</dt><dd><code>{candidate.programRevision}</code></dd></dl>
        <p>{workflowCopy.plannedCalls(candidate.plannedCalls)}</p>
        <WorkflowSystemPlan key={candidate.programRevision} preview={candidate} />
        {candidate.unavailableReasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
        <label>{workflowCopy.program}<textarea className="workflow-template-source" readOnly aria-label={workflowCopy.program} value={JSON.stringify(candidate.program, null, 2)} /></label>
        <p>{workflowCopy.costNotice}</p><p>{workflowCopy.budgetNotice}</p>
      </section> : <>
        <p>{copy.authority}</p>
        <label>{copy.source}<textarea className="workflow-template-source" aria-label={copy.source} spellCheck={false} value={source} disabled={Boolean(busy)} onChange={event => setSource(event.target.value)} /></label>
      </>}
    </>}
    {busy && <p role="status">{busy === 'prepare' ? copy.preparing : copy.executing}</p>}
    <footer>
      <button type="button" onClick={onClose}>{copy.cancel}</button>
      {candidate ? <>
        <button type="button" disabled={Boolean(busy)} onClick={() => { setCandidate(null); setError(null) }}>{copy.edit}</button>
        <button type="button" data-workflow-action="confirm-revision" disabled={Boolean(busy) || candidate.state !== 'ready'} onClick={() => void execute()}>{copy.confirm}</button>
      </> : <button type="button" data-workflow-action="prepare-revision" disabled={!loaded || Boolean(busy)} onClick={() => void prepare()}>{copy.prepare}</button>}
    </footer>
  </ModalFrame>
}
