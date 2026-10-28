import { useEffect, useState } from 'react'
import type { WorkflowPlanPreview } from '@shared/workflow'
import type { WorkflowExecutionInspectionRecord } from '@shared/workflow-inspection'
import type { WorkflowFrameInspection } from '@shared/workflow-api'
import type { WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'
import { workflowProgramStructure, type WorkflowStructureNode } from '../workflow-program-structure'

const MAX_PAGES = 8
const MAX_FRAMES = 128
const PAGE_SIZE = 32

type AvailableFrame = Extract<WorkflowFrameInspection, { state: 'available' }>
type Read = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; records: WorkflowExecutionInspectionRecord[]; frames: Map<string, AvailableFrame>; bounded: boolean; framesBounded: boolean }
export type WorkflowGraphItem = Readonly<{
  kind: 'instance'
  id: string
  nodeId?: string
  category: 'turn' | 'candidate' | 'evidence'
  state: string
  settled?: boolean
  frameId?: string
  parentFrameId?: string
  branch?: string
  retryOf?: string
  retryCommand?: string
  usage: 'unavailable'
}>

function category(record: WorkflowExecutionInspectionRecord): WorkflowGraphItem['category'] {
  if ('attemptId' in record) return 'turn'
  const kind = record.intent.state === 'available' ? record.intent.value.kind : undefined
  return kind === 'prepare_replica' || kind === 'combine' ? 'candidate' : 'evidence'
}
function nodeId(record: WorkflowExecutionInspectionRecord): string | undefined {
  if (record.intent.state === 'available') return record.intent.value.nodeId
  if (record.outcome.state === 'available' && 'attemptId' in record) return record.outcome.value.nodeId
  return undefined
}
function recordState(record: WorkflowExecutionInspectionRecord): { state: string; settled?: boolean } {
  if (record.outcome.state === 'available') return { state: record.outcome.value.state, settled: record.outcome.value.settled }
  return { state: copy.missingOutcome }
}
export function workflowGraphItems(records: readonly WorkflowExecutionInspectionRecord[], frames: ReadonlyMap<string, AvailableFrame>): WorkflowGraphItem[] {
  return records.map(record => {
    const intent = record.intent.state === 'available' ? record.intent.value : undefined
    const attemptIntent = 'attemptId' in record && record.intent.state === 'available' ? record.intent.value : undefined
    const id = 'attemptId' in record ? record.attemptId : record.stepId
    const frameId = intent?.frame.state === 'available' ? intent.frame.frameId : undefined
    const frame = frameId ? frames.get(frameId) : undefined
    const result = recordState(record)
    return { kind: 'instance', id, ...(nodeId(record) ? { nodeId: nodeId(record) } : {}), category: category(record), ...result,
      ...(frameId ? { frameId } : {}), ...(frame?.frame.parentage.state === 'available' ? { parentFrameId: frame.frame.parentage.frameId } : {}),
      ...(frame?.frame.arm ? { branch: frame.frame.arm } : {}),
      ...(attemptIntent?.previousAttemptId ? { retryOf: attemptIntent.previousAttemptId } : {}),
      ...(attemptIntent?.retryCommandId ? { retryCommand: attemptIntent.retryCommandId } : {}), usage: 'unavailable' }
  })
}

async function readPages(workflowId: string, programRevision: string, kind: 'attempts' | 'systems'): Promise<{ records: WorkflowExecutionInspectionRecord[]; bounded: boolean }> {
  const records: WorkflowExecutionInspectionRecord[] = []
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await window.scry.workflow.inspectExecution({ workflowId, programRevision, kind, offset })
    if (response.state !== 'available') throw new Error(response.reason === 'source_changed' ? copy.sourceChanged : copy.sourceMissing)
    records.push(...response.records)
    if (response.nextOffset === undefined) return { records, bounded: false }
    offset = response.nextOffset
  }
  return { records, bounded: true }
}

function GraphInstance({ item, onFrame, onOutput }: { item: WorkflowGraphItem; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  return <li className="workflow-graph-instance" data-workflow-graph-instance={item.id}>
    <div className="workflow-graph-instance-title"><span>{copy[item.category === 'turn' ? 'turnNode' : item.category === 'candidate' ? 'candidateNode' : 'evidenceNode']}</span><code>{item.id}</code></div>
    <div className="workflow-graph-instance-meta"><span>{item.state}</span>{item.settled !== undefined && <span>{item.settled ? copy.settled : copy.unsettled}</span>}
      {item.branch && <span>{copy.branch}: {item.branch}</span>}
      {item.usage === 'unavailable' && <span>{copy.usageUnavailable}</span>}</div>
    <div className="workflow-graph-instance-actions">
      {item.frameId ? <button type="button" data-workflow-graph-frame={item.frameId} onClick={() => onFrame(item.frameId!)}>{copy.frame}</button> : <span>{copy.missingFrame}</span>}
      {item.category === 'turn' && <button type="button" data-workflow-graph-output={item.id} onClick={() => onOutput({ kind: 'attempt', attemptId: item.id })}>{copy.output}</button>}
      {item.retryOf && <span>{copy.retryOf}: <code>{item.retryOf}</code></span>}
      {item.retryCommand && <span>{copy.retryCommand}: <code>{item.retryCommand}</code></span>}
    </div>
    {item.parentFrameId && <p>{copy.parent}: <code>{item.parentFrameId}</code></p>}
  </li>
}

function CodeNode({ node, instances, onFrame, onOutput }: { node: WorkflowStructureNode; instances: WorkflowGraphItem[]; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  return <li className="workflow-graph-code" data-workflow-graph-code={node.block.blockId} style={{ paddingInlineStart: 8 + Math.min(node.depth, 6) * 12 }}>
    <div className="workflow-graph-code-title"><span>{copy.codeNode}</span><code>{node.block.blockId}</code><span>{copy.kinds[node.block.kind]}</span></div>
    {instances.length ? <ol>{instances.map(item => <GraphInstance key={item.id} item={item} onFrame={onFrame} onOutput={onOutput} />)}</ol> : <p>{copy.noInstances}</p>}
  </li>
}

export function WorkflowExecutionGraph({ workflowId, preview, onFrame, onOutput }: { workflowId: string; preview: WorkflowPlanPreview; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  const [read, setRead] = useState<Read>({ state: 'loading' })
  useEffect(() => {
    let current = true
    void Promise.all([readPages(workflowId, preview.programRevision, 'attempts'), readPages(workflowId, preview.programRevision, 'systems')]).then(([attempts, systems]) => {
      const records = [...attempts.records, ...systems.records].slice(0, MAX_PAGES * PAGE_SIZE)
      const frameIds = [...new Set(records.flatMap(record => record.intent.state === 'available' && record.intent.value.frame.state === 'available' ? [record.intent.value.frame.frameId] : []))]
      const frames = new Map<string, AvailableFrame>()
      return Promise.all(frameIds.slice(0, MAX_FRAMES).map(async id => [id, await window.scry.workflow.inspectFrame(workflowId, id)] as const)).then(results => {
        for (const [id, frame] of results) if (frame.state === 'available') frames.set(id, frame)
        if (current) setRead({ state: 'ready', records, frames, bounded: attempts.bounded || systems.bounded, framesBounded: frameIds.length > MAX_FRAMES })
      })
    }).catch(error => { if (current) setRead({ state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [workflowId, preview.programRevision])
  if (read.state === 'loading') return <section className="workflow-execution-graph" aria-busy="true"><h3>{copy.graph}</h3><p role="status">{copy.graphLoading}</p></section>
  if (read.state === 'error') return <section className="workflow-execution-graph"><h3>{copy.graph}</h3><p role="alert">{read.message}</p></section>
  const items = workflowGraphItems(read.records, read.frames)
  const byNode = new Map<string, WorkflowGraphItem[]>()
  for (const item of items) if (item.nodeId) byNode.set(item.nodeId, [...(byNode.get(item.nodeId) ?? []), item])
  const nodes = workflowProgramStructure(preview.program.body)
  return <section className="workflow-execution-graph" aria-label={copy.graph}>
    <h3>{copy.graph}</h3><p>{copy.graphSource}</p><p role="status">{copy.noReinjection}</p>
    {read.bounded && <p role="status">{copy.graphBounded}</p>}
    {read.framesBounded && <p role="status">{copy.graphFramesBounded}</p>}
    {!items.length && <p role="status">{copy.graphUnavailable}</p>}
    <ol className="workflow-graph-code-list">{nodes.map(node => <CodeNode key={node.block.blockId} node={node} instances={byNode.get(node.block.blockId) ?? []} onFrame={onFrame} onOutput={onOutput} />)}</ol>
  </section>
}
