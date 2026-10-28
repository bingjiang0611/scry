import { useEffect, useState } from 'react'
import type { WorkflowPlanPreview } from '@shared/workflow'
import type { WorkflowExecutionInspectionRecord } from '@shared/workflow-inspection'
import type { WorkflowFrameInspection } from '@shared/workflow-api'
import type { WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import type { WorkflowUsage } from '@shared/workflow-usage'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'
import { workflowProgramStructure, type WorkflowStructureNode } from '../workflow-program-structure'

type AvailableFrame = Extract<WorkflowFrameInspection, { state: 'available' }>
type Read = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; records: WorkflowExecutionInspectionRecord[]; frames: Map<string, AvailableFrame>; truncated: boolean; framesTruncated: boolean }
export type WorkflowGraphItem = Readonly<{
  kind: 'instance'
  id: string
  nodeId?: string
  category: 'turn' | 'candidate' | 'evidence' | 'control' | 'classifier'
  state: string
  settled?: boolean
  frameId?: string
  parentFrameId?: string
  branch?: string
  retryOf?: string
  retryCommand?: string
  usage: 'unavailable' | WorkflowUsage
}>

function category(record: WorkflowExecutionInspectionRecord): WorkflowGraphItem['category'] {
  if ('attemptId' in record) return 'turn'
  if ('classifierId' in record) return 'classifier'
  const kind = record.intent.state === 'available' ? String(record.intent.value.kind) : undefined
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
export function workflowGraphItems(records: readonly WorkflowExecutionInspectionRecord[], frames: ReadonlyMap<string, AvailableFrame>, usage: ReadonlyMap<string, WorkflowUsage> = new Map()): WorkflowGraphItem[] {
  // Control-only frames are not a graph source: Main does not provide a
  // bounded list operation for them. Effect rows may reference their own
  // canonical frame, which is the only frame claim retained here.
  return [...records.map(record => {
    const intent = record.intent.state === 'available' ? record.intent.value : undefined
    const attemptIntent = 'attemptId' in record && record.intent.state === 'available' ? record.intent.value : undefined
    const id = 'attemptId' in record ? record.attemptId : record.stepId
    const frameId = intent?.frame.state === 'available' ? intent.frame.frameId : undefined
    const frame = frameId ? frames.get(frameId) : undefined
    const result = recordState(record)
    return { kind: 'instance' as const, id, ...(nodeId(record) ? { nodeId: nodeId(record) } : {}), category: category(record), ...result,
      ...(frameId ? { frameId } : {}), ...(frame?.frame.parentage.state === 'available' ? { parentFrameId: frame.frame.parentage.frameId } : {}),
      ...(frame?.frame.arm ? { branch: frame.frame.arm } : {}),
      ...(attemptIntent?.previousAttemptId ? { retryOf: attemptIntent.previousAttemptId } : {}),
      ...(attemptIntent?.retryCommandId ? { retryCommand: attemptIntent.retryCommandId } : {}), usage: usage.get(id) ?? 'unavailable' as const }
  })]
}

async function readPage(workflowId: string, programRevision: string, kind: 'attempts' | 'systems' | 'classifiers') {
  const response = await window.scry.workflow.inspectExecution({ workflowId, programRevision, kind, offset: 0 })
  if (response.state !== 'available') throw new Error(response.reason === 'source_changed' ? copy.sourceChanged : copy.sourceMissing)
  return response
}

function GraphInstance({ item, onFrame, onOutput }: { item: WorkflowGraphItem; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  return <li className="workflow-graph-instance" data-workflow-graph-instance={item.id}>
    <div className="workflow-graph-instance-title"><span>{copy[item.category === 'turn' ? 'turnNode' : item.category === 'candidate' ? 'candidateNode' : item.category === 'control' ? 'controlNode' : item.category === 'classifier' ? 'classifierNode' : 'evidenceNode']}</span><code>{item.id}</code></div>
    <div className="workflow-graph-instance-meta"><span>{item.state}</span>{item.settled !== undefined && <span>{item.settled ? copy.settled : copy.unsettled}</span>}
      {item.branch && <span>{copy.branch}: {item.branch}</span>}
      {(item.usage === 'unavailable' || item.usage.provenance === 'unavailable') && <span>{copy.usageUnavailable}</span>}</div>
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
    void Promise.all([readPage(workflowId, preview.programRevision, 'attempts'), readPage(workflowId, preview.programRevision, 'systems'), readPage(workflowId, preview.programRevision, 'classifiers')]).then(async pages => {
      const records = pages.flatMap(page => page.records)
      const allFrameIds = [...new Set(records.flatMap(record => record.intent.state === 'available' && record.intent.value.frame.state === 'available' ? [record.intent.value.frame.frameId] : []))]
      const frameIds = allFrameIds.slice(0, 64)
      const frames = new Map<string, AvailableFrame>()
      for (let index = 0; index < frameIds.length; index += 8) {
        const batch = frameIds.slice(index, index + 8)
        const results = await Promise.all(batch.map(async id => [id, await window.scry.workflow.inspectFrame(workflowId, id)] as const))
        for (const [id, frame] of results) if (frame.state === 'available') frames.set(id, frame)
      }
      if (current) setRead({ state: 'ready', records, frames, truncated: pages.some(page => page.nextOffset !== undefined), framesTruncated: allFrameIds.length > frameIds.length })
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
    {!items.length && <p role="status">{copy.graphUnavailable}</p>}
    {read.truncated && <p role="status">{copy.graphBounded}</p>}
    {read.framesTruncated && <p role="status">{copy.graphFramesBounded}</p>}
    <ol className="workflow-graph-code-list">{nodes.map(node => <CodeNode key={node.block.blockId} node={node} instances={byNode.get(node.block.blockId) ?? []} onFrame={onFrame} onOutput={onOutput} />)}</ol>
  </section>
}
