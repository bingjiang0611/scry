import { useEffect, useRef, useState } from 'react'
import { WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE, type WorkflowExecutionInspection, type WorkflowExecutionInspectionKind, type WorkflowExecutionInspectionRecord } from '@shared/workflow-inspection'
import type { WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'

type Page = Extract<WorkflowExecutionInspection, { state: 'available' }>
type Read = { offset: number; sequence: number } & (
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; page: WorkflowExecutionInspection }
)

function ExecutionRecord({ record, programRevision, onFrame, onOutput }: { record: WorkflowExecutionInspectionRecord; programRevision: string; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  const intent = record.intent.state === 'available' ? record.intent.value : undefined
  const outcome = record.outcome.state === 'available' ? record.outcome.value : undefined
  const isAttempt = 'attemptId' in record, isClassifier = 'classifierId' in record, isSystem = !isAttempt && !isClassifier
  const node = intent?.nodeId ?? (isAttempt && record.outcome.state === 'available' ? record.outcome.value.nodeId : copy.unavailable)
  const id = isAttempt ? record.attemptId : isClassifier ? record.classifierId : record.stepId
  const lifecycleLabel = outcome ? copy.states[outcome.state] : copy.missingOutcome
  const systemReturned = isSystem && outcome?.state === 'completed'
  const fields: [string, string][] = [[copy.record, id]]
  if (intent) fields.push([copy.revision, intent.programRevision], [copy.createdAt, new Date(intent.createdAt).toLocaleString()])
  if (isSystem) {
    if (record.intent.state === 'available') fields.push([copy.kind, copy.systemKinds[record.intent.value.kind]])
    if (record.outcome.state === 'available') fields.push([copy.startedAt, new Date(record.outcome.value.startedAt).toLocaleString()], [copy.finishedAt, new Date(record.outcome.value.finishedAt).toLocaleString()])
  }
  if (isClassifier && intent) fields.push([copy.kind, copy.kinds.classifier])
  if (isAttempt && record.outcome.state === 'available') fields.push([copy.usage, record.outcome.value.usage ? copy.usageSummary(record.outcome.value.usage) : copy.usageUnavailable])
  if ('attemptId' in record) {
    if (record.intent.state === 'available') {
      const admitted = record.intent.value
      fields.push([copy.role, admitted.role], [copy.provider, admitted.providerId])
      if (admitted.requestedModel !== undefined) fields.push([copy.requestedModel, typeof admitted.requestedModel === 'string' ? admitted.requestedModel : JSON.stringify(admitted.requestedModel)])
      if (admitted.previousAttemptId) fields.push([copy.previousAttempt, admitted.previousAttemptId])
      if (admitted.retryCommandId) fields.push([copy.retryCommand, admitted.retryCommandId])
    }
    if (record.outcome.state === 'available') {
      const result = record.outcome.value
      if (!intent) {
        fields.push([copy.role, result.role], [copy.provider, result.providerId])
        if (result.requestedModel !== undefined) fields.push([copy.requestedModel, typeof result.requestedModel === 'string' ? result.requestedModel : JSON.stringify(result.requestedModel)])
      }
      fields.push([copy.actualModel, result.actualModelStatus === 'observed' && result.actualModel !== undefined ? result.actualModel : copy.unavailable])
      if (result.runId) fields.push([copy.run, result.runId])
    }
  }
  return <li data-workflow-inspection-record={id}>
    <div className="workflow-history-row"><code>{node}</code>
      <span>{systemReturned ? copy.systemReturned : lifecycleLabel}</span>
      <span>{outcome ? outcome.settled ? copy.settled : copy.unsettled : copy.unavailable}</span>
    </div>
    {intent && intent.programRevision !== programRevision && <p role="status">{copy.otherRevision}<code>{intent.programRevision}</code></p>}
    {isClassifier && record.outcome.state === 'available' && <dl className="workflow-classifier-result" data-workflow-classifier-result={record.classifierId}>
      <div><dt>{copy.classifierResult}</dt><dd>{record.outcome.value.value === undefined ? copy.unavailable : String(record.outcome.value.value)}</dd></div>
      <div><dt>{copy.confidence}</dt><dd>{record.outcome.value.confidence === undefined ? copy.unavailable : String(record.outcome.value.confidence)}</dd></div>
      <div><dt>{copy.probability}</dt><dd>{record.outcome.value.probability === undefined ? copy.unavailable : <pre>{JSON.stringify(record.outcome.value.probability, null, 2)}</pre>}</dd></div>
      <div><dt>{copy.usage}</dt><dd>{record.outcome.value.usage ? copy.usageSummary(record.outcome.value.usage) : copy.usageUnavailable}</dd></div>
    </dl>}
    <div className="workflow-history-actions">
      {intent?.frame.state === 'available'
        ? <button type="button" data-workflow-inspection-frame={intent.frame.frameId} onClick={() => { if (intent.frame.state === 'available') onFrame(intent.frame.frameId) }}>{copy.frame}</button>
        : <span>{copy.missingFrame}</span>}
      {!intent && <span>{copy.missingIntent}</span>}
      {outcome && (isAttempt
        ? <button type="button" data-workflow-inspection-output="attempt" onClick={() => onOutput({ kind: 'attempt', attemptId: record.attemptId })}>{copy.output}</button>
        : isSystem ? <><button type="button" data-workflow-inspection-output="result" onClick={() => onOutput({ kind: 'system', stepId: record.stepId, field: 'result' })}>{copy.result}</button>
          <button type="button" data-workflow-inspection-output="stdout" onClick={() => onOutput({ kind: 'system', stepId: record.stepId, field: 'stdout' })}>{copy.stdout}</button>
          <button type="button" data-workflow-inspection-output="stderr" onClick={() => onOutput({ kind: 'system', stepId: record.stepId, field: 'stderr' })}>{copy.stderr}</button></> : null)}
      <details><summary>{copy.details}</summary><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
        {outcome && 'error' in outcome && outcome.error !== undefined && <p className="workflow-history-error">{outcome.error}</p>}
        {outcome && 'reason' in outcome && outcome.reason !== undefined && <p className="workflow-history-error">{outcome.reason}</p>}
        {outcome && 'errorTruncated' in outcome && outcome.errorTruncated && <p>{copy.errorTruncated}</p>}
      </details>
    </div>
  </li>
}

export function WorkflowExecutionHistory({ workflowId, programRevision, nodeId, kind, onFrame, onOutput, onReloadSource }: {
  workflowId: string; programRevision: string; nodeId?: string; kind: WorkflowExecutionInspectionKind; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void; onReloadSource: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [request, setRequest] = useState({ offset: 0, sequence: 0 })
  const [read, setRead] = useState<Read>({ ...request, state: 'loading' })
  useEffect(() => {
    let current = true
    void window.scry.workflow.inspectExecution({ workflowId, programRevision, kind, ...(nodeId ? { nodeId } : {}), offset: request.offset }).then(page => {
      if (current) setRead({ ...request, state: 'ready', page })
    }).catch(error => { if (current) setRead({ ...request, state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [workflowId, programRevision, kind, nodeId, request])
  const current = read.offset === request.offset && read.sequence === request.sequence ? read : { ...request, state: 'loading' as const }
  const page: Page | undefined = current.state === 'ready' && current.page.state === 'available' ? current.page : undefined
  const move = (offset: number) => { heading.current?.focus(); setRequest(previous => ({ offset, sequence: previous.sequence + 1 })) }
  return <section className="workflow-execution-history" aria-busy={current.state === 'loading'}>
    <h3 ref={heading} tabIndex={-1}>{copy.ledger}</h3>
    {current.state === 'loading' && <p role="status">{copy.loading}</p>}
    {current.state === 'error' && <p role="alert">{current.message}</p>}
    {current.state === 'ready' && current.page.state === 'unavailable' && <p role="status">{current.page.reason === 'source_changed' ? copy.sourceChanged : copy.sourceMissing}</p>}
    {current.state === 'ready' && current.page.state === 'unavailable' && current.page.reason === 'source_changed' && <button type="button" onClick={onReloadSource}>{copy.reloadProgram}</button>}
    {page && <>
      <p data-workflow-inspection-page>{copy.historyPage(page.total === 0 ? 0 : page.offset + 1, page.offset + page.records.length, page.total)}</p>
      <time dateTime={new Date(page.observedAt).toISOString()}>{new Date(page.observedAt).toLocaleString()}</time>
      {page.records.length ? <ol>{page.records.map(record => <ExecutionRecord key={'attemptId' in record ? record.attemptId : 'classifierId' in record ? record.classifierId : record.stepId} record={record} programRevision={programRevision} onFrame={onFrame} onOutput={onOutput} />)}</ol> : <p role="status">{copy.empty}</p>}
    </>}
    <footer>
      <button type="button" data-workflow-inspection-page-action="previous" disabled={current.state === 'loading' || request.offset === 0} onClick={() => move(Math.max(0, request.offset - WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE))}>{copy.previous}</button>
      <button type="button" data-workflow-inspection-page-action="refresh" disabled={current.state === 'loading'} onClick={() => move(request.offset)}>{copy.refresh}</button>
      <button type="button" data-workflow-inspection-page-action="next" disabled={!page?.nextOffset || current.state === 'loading'} onClick={() => { if (page?.nextOffset !== undefined) move(page.nextOffset) }}>{copy.next}</button>
    </footer>
  </section>
}
