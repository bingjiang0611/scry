import { useMemo, useState } from 'react'
import type { WorkflowPlanPreview } from '@shared/workflow'
import type { WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'
import { workflowProgramStructure, type WorkflowStructureNode } from '../workflow-program-structure'
import { workflowGraphItems, type WorkflowGraphItem } from '../workflow-graph'
import { useWorkflowGraph } from '../hooks/useWorkflowGraph'
import { WORKFLOW_STRUCTURE_PAGE_SIZE } from '../workflow-flow-layout'
import { WorkflowGraphCanvas } from './WorkflowGraphCanvas'
export { workflowGraphItems } from '../workflow-graph'
export type { WorkflowGraphItem } from '../workflow-graph'

function GraphInstance({ item, onFrame, onOutput }: { item: WorkflowGraphItem; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  return <li className="workflow-graph-instance" data-workflow-graph-instance={item.id}>
    <div className="workflow-graph-instance-title"><span>{copy[item.category === 'turn' ? 'turnNode' : item.category === 'candidate' ? 'candidateNode' : item.category === 'control' ? 'controlNode' : item.category === 'classifier' ? 'classifierNode' : 'evidenceNode']}</span><code>{item.id}</code></div>
    <div className="workflow-graph-instance-meta"><span>{copy.states[item.state as keyof typeof copy.states] ?? item.state}</span>{item.settled !== undefined && <span>{item.settled ? copy.settled : copy.unsettled}</span>}
      {item.branch && <span>{copy.branch}: {item.branch}</span>}
      <span title={item.usage === 'unavailable' ? undefined : item.usage.reason}>{item.usage === 'unavailable' ? copy.usageUnavailable : copy.usageSummary(item.usage)}</span></div>
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
  return <li className="workflow-graph-code" data-workflow-graph-code={node.block.blockId}>
    <div className="workflow-graph-code-title"><span>{copy.codeNode}</span><code>{node.block.blockId}</code><span>{copy.kinds[node.block.kind]}</span></div>
    {instances.length ? <ol>{instances.map(item => <GraphInstance key={item.id} item={item} onFrame={onFrame} onOutput={onOutput} />)}</ol> : <p>{copy.noInstances}</p>}
  </li>
}

export function WorkflowExecutionGraph({ workflowId, preview, onFrame, onOutput }: { workflowId: string; preview: WorkflowPlanPreview; onFrame: (id: string) => void; onOutput: (selection: WorkflowOutputSelection) => void }) {
  const read = useWorkflowGraph(workflowId, preview.programRevision)
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState(preview.program.body.blockId)
  const nodes = useMemo(() => workflowProgramStructure(preview.program.body), [preview])
  const visible = useMemo(() => nodes.slice(page * WORKFLOW_STRUCTURE_PAGE_SIZE, (page + 1) * WORKFLOW_STRUCTURE_PAGE_SIZE), [nodes, page])
  const items = useMemo(() => read.state === 'ready' ? workflowGraphItems(read.records, read.frames) : [], [read])
  const selected = visible.find(node => node.block.blockId === selectedId) ?? visible[0]
  return <section className="workflow-execution-graph" aria-label={copy.graph}>
    <h3>{copy.graph}</h3><p>{copy.graphSource}</p><p role="status">{copy.noReinjection}</p>
    {read.state === 'loading' && <p role="status">{copy.graphLoading}</p>}
    {read.state === 'error' && <p role="alert">{read.message}</p>}
    {read.state === 'ready' && <>
      {!items.length && <p role="status">{copy.graphUnavailable}</p>}
      {read.truncated && <p role="status">{copy.graphBounded}</p>}
      {read.framesTruncated && <p role="status">{copy.graphFramesBounded}</p>}
      {read.unassociated > 0 && <p role="status">{copy.graphUnassociated}</p>}
    </>}
    <WorkflowGraphCanvas nodes={visible} items={items} selectedId={selected.block.blockId} onSelect={setSelectedId} />
    <div className="workflow-inspection-pagination">
      <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{copy.previous}</button>
      <span>{copy.structurePage(page * WORKFLOW_STRUCTURE_PAGE_SIZE + 1, Math.min((page + 1) * WORKFLOW_STRUCTURE_PAGE_SIZE, nodes.length), nodes.length)}</span>
      <button type="button" disabled={(page + 1) * WORKFLOW_STRUCTURE_PAGE_SIZE >= nodes.length} onClick={() => setPage(value => value + 1)}>{copy.next}</button>
    </div>
    <ol className="workflow-graph-code-list"><CodeNode node={selected} instances={items.filter(item => item.nodeId === selected.block.blockId)} onFrame={onFrame} onOutput={onOutput} /></ol>
  </section>
}
