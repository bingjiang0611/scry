import { useEffect, useId, useRef, useState } from 'react'
import type { WorkflowOutputInspection, WorkflowOutputInspectionRequest, WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import { WORKFLOW_OUTPUT_COPY as copy } from '@shared/constants/workflow-output-copy'
import { ModalFrame } from './Modals'

type RequestState = { offset: number; sequence: number; expectedContentHash?: string }
type ReadState = { request: RequestState } & (
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; page: WorkflowOutputInspection }
)
function label(selection: WorkflowOutputSelection): string {
  return selection.kind === 'attempt' ? copy.output : selection.kind === 'frame' ? copy.frameResult : selection.field === 'result' ? copy.result : selection.field === 'stdout' ? copy.stdout : copy.stderr
}
function unavailable(page: Extract<WorkflowOutputInspection, { state: 'unavailable' }>): string {
  switch (page.reason) {
    case 'selection_missing': return copy.missingSelection
    case 'source_changed': return copy.sourceChanged
    case 'root_missing': return copy.sourceMissing
    case 'frame_missing': return copy.frameMissing
    case 'output_missing': return copy.noOutput
    case 'value_unknown': return page.detail ? copy.unknownDetail(page.detail) : copy.unknown
    case 'content_changed': return copy.contentChanged
  }
}

export function WorkflowOutputInspector({ workflowId, programRevision, selection, onClose }: {
  workflowId: string
  programRevision: string
  selection: WorkflowOutputSelection
  onClose: () => void
}) {
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [request, setRequest] = useState<RequestState>({ offset: 0, sequence: 0 })
  const [read, setRead] = useState<ReadState>({ request: { offset: 0, sequence: 0 }, state: 'loading' })
  const [history, setHistory] = useState<number[]>([])
  const selectionKind = selection.kind
  const selectionId = selection.kind === 'attempt' ? selection.attemptId : selection.kind === 'system' ? selection.stepId : selection.frameId
  const selectionField = selection.kind === 'system' ? selection.field : undefined
  // Streaming parent renders may recreate the selector object, not the logical record.
  useEffect(() => {
    let current = true
    const input: WorkflowOutputInspectionRequest = { workflowId, programRevision, selection, offset: request.offset,
      ...(request.expectedContentHash ? { expectedContentHash: request.expectedContentHash } : {}) }
    void window.scry.workflow.inspectOutput(input).then(page => {
      if (current) setRead({ request, state: 'ready', page })
    }).catch(error => {
      if (current) setRead({ request, state: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [workflowId, programRevision, selectionKind, selectionId, selectionField, request])
  const current = read.request.offset === request.offset && read.request.sequence === request.sequence ? read : { request, state: 'loading' as const }
  const page = current.state === 'ready' && current.page.state === 'available' ? current.page : undefined
  const move = (offset: number, expectedContentHash?: string) => {
    heading.current?.focus()
    setRequest(previous => ({ offset, sequence: previous.sequence + 1, ...(expectedContentHash ? { expectedContentHash } : {}) }))
  }
  return <ModalFrame labelledBy={titleId} className="workflow-output-inspector" onClose={onClose}>
    <header><h2 id={titleId} ref={heading} tabIndex={-1}>{label(selection)}</h2><button type="button" data-workflow-output-action="close" onClick={onClose}>{copy.close}</button></header>
    {current.state === 'loading' && <p role="status">{copy.loading}</p>}
    {current.state === 'error' && <p role="alert">{copy.readError(current.message)}</p>}
    {current.state === 'ready' && current.page.state === 'unavailable' && <p role="status">{unavailable(current.page)}</p>}
    {page && <>
      <dl className="workflow-output-metadata">
        <div><dt>{copy.currentRevision}</dt><dd><code>{page.programRevision}</code></dd></div>
        <div><dt>{copy.sourceRevision}</dt><dd><code>{page.sourceRevision.state === 'available' ? page.sourceRevision.programRevision : copy.unavailable}</code></dd></div>
        <div><dt>{copy.expectedHash}</dt><dd><code>{page.contentHash}</code></dd></div>
      </dl>
      {page.captureTruncated && <p role="status">{copy.truncated}</p>}
      <p data-workflow-output-page>{copy.pageWindow(page.total === 0 ? 0 : page.offset + 1, page.offset + page.content.length, page.total)}</p>
      {page.content.length === 0 ? <p role="status">{copy.empty}</p> : <textarea readOnly spellCheck={false} aria-label={page.contentKind === 'json' ? copy.json : copy.text} value={page.content} />}
    </>}
    <footer className="workflow-output-actions">
      <button type="button" data-workflow-output-action="previous" disabled={current.state === 'loading' || history.length === 0} onClick={() => {
        const previous = history.at(-1)
        if (previous === undefined) return
        setHistory(values => values.slice(0, -1)); move(previous, previous === 0 ? undefined : page?.contentHash ?? request.expectedContentHash)
      }}>{copy.previous}</button>
      <button type="button" data-workflow-output-action="refresh" disabled={current.state === 'loading'} onClick={() => {
        if (current.state === 'ready' && current.page.state === 'unavailable' && current.page.reason === 'content_changed') {
          setHistory([]); move(0)
        } else move(request.offset, request.offset === 0 ? undefined : page?.contentHash ?? request.expectedContentHash)
      }}>{copy.refresh}</button>
      <button type="button" data-workflow-output-action="next" disabled={!page?.nextOffset || current.state === 'loading'} onClick={() => { if (page?.nextOffset !== undefined) { setHistory(values => [...values, request.offset]); move(page.nextOffset, page.contentHash) } }}>{copy.next}</button>
    </footer>
  </ModalFrame>
}
