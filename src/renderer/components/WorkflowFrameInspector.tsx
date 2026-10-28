import { useEffect, useId, useRef, useState } from 'react'
import type { WorkflowFrameInspection } from '@shared/workflow-api'
import { WORKFLOW_FRAME_COPY as copy } from '../constants/workflow-frame-copy'
import { ModalFrame } from './Modals'
import { WorkflowOutputInspector } from './WorkflowOutputInspector'

type AvailableFrame = Extract<WorkflowFrameInspection, { state: 'available' }>
type Request = { frameId: string; sequence: number }
type ReadState = { request: Request } & (
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; evidence: WorkflowFrameInspection }
)
const pathLimit = 32

export function WorkflowFrameMetadata({ evidence, path, onFollow, onOutput }: {
  evidence: AvailableFrame
  path: readonly string[]
  onFollow: (frameId: string) => void
  onOutput: () => void
}) {
  const { frame } = evidence
  const rows: [string, string | number][] = [
    [copy.labels.node, frame.nodeId], [copy.labels.frame, frame.frameId], [copy.labels.program, frame.programRevision],
    [copy.labels.version, frame.revision]
  ]
  if (frame.executionEpoch !== undefined) rows.push([copy.labels.epoch, frame.executionEpoch])
  if (frame.generationId !== undefined) rows.push([copy.labels.generation, frame.generationId])
  if (frame.cursor !== undefined) rows.push([copy.labels.cursor, frame.cursor])
  const relation = (frameId: string, label: string) => {
    const blocked = path.includes(frameId) ? copy.cycle : path.length >= pathLimit ? copy.limit : undefined
    return <div className="workflow-frame-relation">
      <button type="button" data-workflow-frame-link={frameId} disabled={Boolean(blocked)} onClick={() => onFollow(frameId)}>{label}<code>{frameId}</code></button>
      {blocked && <p role="status">{blocked}</p>}
    </div>
  }
  return <section className="workflow-frame-record" data-workflow-frame={frame.frameId}>
    <p className="workflow-frame-phase">{copy.phase[frame.phase]}</p>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
    <p>{copy.source}</p>
    <p><span>{copy.labels.observed}</span><time dateTime={new Date(evidence.observedAt).toISOString()}>{new Date(evidence.observedAt).toLocaleString()}</time></p>
    <div className="workflow-frame-relations">
      {frame.parentage.state === 'available' ? relation(frame.parentage.frameId, copy.parent)
        : <p>{frame.parentage.state === 'root' ? copy.root : copy.legacy}</p>}
      {frame.originFrameId !== undefined && relation(frame.originFrameId, copy.origin)}
    </div>
    <button type="button" data-workflow-frame-output={frame.frameId} onClick={onOutput}>{copy.output}</button>
  </section>
}

export function WorkflowFrameInspector({ workflowId, frameId, programRevision, onClose }: {
  workflowId: string
  frameId: string
  programRevision: string
  onClose: () => void
}) {
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [path, setPath] = useState([frameId])
  const [request, setRequest] = useState<Request>({ frameId, sequence: 0 })
  const [read, setRead] = useState<ReadState>({ request, state: 'loading' })
  const [outputOpen, setOutputOpen] = useState(false)
  useEffect(() => {
    let current = true
    void window.scry.workflow.inspectFrame(workflowId, request.frameId).then(evidence => {
      if (current) setRead({ request, state: 'ready', evidence })
    }).catch(error => {
      if (current) setRead({ request, state: 'error', message: copy.readError(error instanceof Error ? error.message : String(error)) })
    })
    return () => { current = false }
  }, [workflowId, request])
  const view: ReadState = read.request === request ? read : { request, state: 'loading' }
  const navigate = (next: string[]) => {
    heading.current?.focus()
    setPath(next)
    setRequest(previous => ({ frameId: next.at(-1)!, sequence: previous.sequence + 1 }))
  }
  return <ModalFrame labelledBy={titleId} className="workflow-frame-inspector" onClose={onClose}>
    <header><h2 id={titleId} ref={heading} tabIndex={-1}>{copy.title}</h2><button type="button" data-workflow-frame-action="close" onClick={onClose}>{copy.close}</button></header>
    <p>{copy.scope}</p>
    {view.state === 'loading' && <p role="status">{copy.loading}</p>}
    {view.state === 'error' && <p role="alert">{view.message}</p>}
    {view.state === 'ready' && (view.evidence.state === 'available'
      ? <WorkflowFrameMetadata evidence={view.evidence} path={path} onFollow={next => navigate([...path, next])} onOutput={() => setOutputOpen(true)} />
      : <p role="status">{copy.unavailable[view.evidence.reason]}</p>)}
    <footer>
      <button type="button" data-workflow-frame-action="back" disabled={path.length === 1} onClick={() => navigate(path.slice(0, -1))}>{copy.back}</button>
      <button type="button" data-workflow-frame-action="refresh" disabled={view.state === 'loading'} onClick={() => navigate(path)}>{copy.refresh}</button>
    </footer>
    {outputOpen && view.state === 'ready' && view.evidence.state === 'available' && <WorkflowOutputInspector key={`${workflowId}:${programRevision}:${view.evidence.frame.frameId}`} workflowId={workflowId} programRevision={programRevision} selection={{ kind: 'frame', frameId: view.evidence.frame.frameId }} onClose={() => setOutputOpen(false)} />}
  </ModalFrame>
}
