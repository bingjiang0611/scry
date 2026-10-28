import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowPlanPreview, WorkflowProgress } from '@shared/workflow'
import type { WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import { WORKFLOW_INSPECTION_COPY as inspection } from '../constants/workflow-inspection-copy'
import { WORKFLOW_WORKSPACE_COPY as copy } from '../constants/workflow-workspace-copy'
import { workflowProgramStructure, workflowInspectionKind } from '../workflow-program-structure'
import { workflowGraphItems } from '../workflow-graph'
import { WORKFLOW_STRUCTURE_PAGE_SIZE } from '../workflow-flow-layout'
import { useWorkflowGraph } from '../hooks/useWorkflowGraph'
import { WorkflowGraphCanvas } from './WorkflowGraphCanvas'
import { WorkflowExecutionHistory } from './WorkflowExecutionHistory'
import { WorkflowFrameInspector } from './WorkflowFrameInspector'
import { WorkflowOutputInspector } from './WorkflowOutputInspector'

const SOURCE_LIMIT = 16 * 1024

export function WorkflowRunSurface({ preview, progress, onReloadSource }: { preview: WorkflowPlanPreview; progress: WorkflowProgress; onReloadSource: () => void }) {
  const nodes = useMemo(() => workflowProgramStructure(preview.program.body), [preview])
  const initialIndex = useMemo(() => Math.max(0, nodes.findIndex(node => ['call', 'classifier', 'check', 'replica', 'combine', 'verification'].includes(node.block.kind))), [nodes])
  const [selectedId, setSelectedId] = useState(nodes[initialIndex].block.blockId)
  const [page, setPage] = useState(Math.floor(initialIndex / WORKFLOW_STRUCTURE_PAGE_SIZE))
  const [refresh, setRefresh] = useState(0)
  const [frameId, setFrameId] = useState<string>()
  const [output, setOutput] = useState<WorkflowOutputSelection>()
  const selectedButton = useRef<HTMLButtonElement>(null)
  const refreshKey = JSON.stringify([refresh, progress.state, progress.outcomeCount, progress.dispatchAttempts, progress.systemSteps?.map(step => [step.stepId, step.state])])
  // The canvas uses record states; the evidence inspector reads frame details on demand.
  const read = useWorkflowGraph(progress.workflowId, preview.programRevision, refreshKey, false)
  const items = useMemo(() => read.state === 'ready' ? workflowGraphItems(read.records, read.frames) : [], [read])
  const visible = useMemo(() => nodes.slice(page * WORKFLOW_STRUCTURE_PAGE_SIZE, (page + 1) * WORKFLOW_STRUCTURE_PAGE_SIZE), [nodes, page])
  const selected = nodes.find(node => node.block.blockId === selectedId)!
  const source = useMemo(() => JSON.stringify(selected.block, null, 2), [selected.block])
  const admittedIds = new Set(items.filter(item => item.category === 'turn').map(item => item.id))
  const runningNodeIds = progress.attempts.filter(attempt => admittedIds.has(attempt.attemptId) && (attempt.state === 'running' || attempt.state === 'dispatched')).map(attempt => attempt.nodeId)
  const move = (next: number) => {
    setPage(next)
    setSelectedId(nodes[next * WORKFLOW_STRUCTURE_PAGE_SIZE].block.blockId)
  }
  useEffect(() => { selectedButton.current?.scrollIntoView({ block: 'nearest' }) }, [selectedId])
  return <div className="workflow-run-layout" data-workflow-run-source={preview.programRevision}>
    <aside className="workflow-run-program" aria-label={copy.program}>
      <div className="workflow-run-program-heading"><h3>{copy.program}</h3><span>{copy.programSource}</span></div>
      <dl className="workflow-workspace-metadata">
        <div><dt>{copy.provider}</dt><dd>{preview.orchestrator.providerId}</dd></div>
        <div><dt>{copy.model}</dt><dd>{preview.orchestrator.requestedModel?.id ?? copy.unavailable}</dd></div>
        <div><dt>{copy.sameRevision}</dt><dd><code title={preview.programRevision}>{preview.programRevision.slice(0, 12)}</code></dd></div>
      </dl>
      <ol className="workflow-run-code-list">{visible.map((node, index) => <li key={node.block.blockId}>
        <button type="button" ref={node.block.blockId === selectedId ? selectedButton : undefined}
          data-workflow-workspace-code={node.block.blockId} aria-pressed={node.block.blockId === selectedId}
          onClick={() => setSelectedId(node.block.blockId)} style={{ paddingInlineStart: 8 + Math.min(node.depth, 5) * 10 }}>
          <span className="workflow-run-line">{page * WORKFLOW_STRUCTURE_PAGE_SIZE + index + 1}</span>
          <span><span className="workflow-run-code-kind">{inspection.kinds[node.block.kind]}</span><code title={node.block.blockId}>{node.block.blockId}</code></span>
        </button>
      </li>)}</ol>
      <div className="workflow-run-code-pagination"><span>{copy.structurePage(page * WORKFLOW_STRUCTURE_PAGE_SIZE + 1, Math.min((page + 1) * WORKFLOW_STRUCTURE_PAGE_SIZE, nodes.length), nodes.length)}</span>
        <button type="button" data-workflow-workspace-page="previous" disabled={page === 0} onClick={() => move(page - 1)}>{copy.previous}</button>
        <button type="button" data-workflow-workspace-page="next" disabled={(page + 1) * WORKFLOW_STRUCTURE_PAGE_SIZE >= nodes.length} onClick={() => move(page + 1)}>{copy.next}</button>
      </div>
    </aside>
    <div className="workflow-run-canvas">
      <div className="workflow-run-ledger-status">
        <span>{read.state === 'ready' ? copy.readAt(read.observedAt) : read.state === 'loading' ? inspection.graphLoading : copy.ledgerUnavailable}</span>
        <button type="button" data-workflow-workspace-refresh disabled={read.state === 'loading'} onClick={() => setRefresh(value => value + 1)}>{copy.refresh}</button>
      </div>
      {read.state === 'error' && <p role="alert">{read.message}</p>}
      {read.state === 'ready' && read.truncated && <p role="status">{copy.partial}</p>}
      {read.state === 'ready' && read.framesTruncated && <p role="status">{inspection.graphFramesBounded}</p>}
      {read.state === 'ready' && read.unassociated > 0 && <p role="status">{inspection.graphUnassociated}</p>}
      <WorkflowGraphCanvas nodes={visible} items={items} selectedId={selectedId} onSelect={setSelectedId} runningNodeIds={runningNodeIds} />
      <details className="workflow-run-definition"><summary>{copy.nodeSource}<code>{selectedId}</code></summary>
        <p>{selected.parentId ? copy.parent : copy.root}{selected.parentId && <code>{selected.parentId}</code>}</p>
        {selected.parentId && !visible.some(node => node.block.blockId === selected.parentId) && <p>{copy.parentOutsidePage}</p>}
        <pre data-workflow-workspace-definition={selectedId}>{source.slice(0, SOURCE_LIMIT)}</pre>
        {source.length > SOURCE_LIMIT && <p role="status">{copy.sourceTruncated}</p>}
      </details>
      <details className="workflow-run-report"><summary>{copy.finalReport}</summary>{progress.finalReportStatus === 'available' && progress.finalReport !== undefined
        ? <pre>{progress.finalReport}</pre> : <p>{copy.noFinalReport}</p>}</details>
    </div>
    <aside className="workflow-run-evidence" aria-label={copy.details}>
      <h3>{copy.selected}<code data-workflow-workspace-selected={selectedId}>{selectedId}</code></h3>
      {selected.block.kind === 'classifier' && selected.block.threshold && <p>{copy.threshold}<code>{JSON.stringify(selected.block.threshold)}</code></p>}
      <WorkflowExecutionHistory key={`${selectedId}:${refreshKey}`} workflowId={progress.workflowId} programRevision={preview.programRevision}
        nodeId={selectedId} kind={workflowInspectionKind(selected.block)} onFrame={setFrameId} onOutput={setOutput} onReloadSource={onReloadSource} />
    </aside>
    {frameId && <WorkflowFrameInspector key={frameId} workflowId={progress.workflowId} programRevision={preview.programRevision} frameId={frameId} onClose={() => setFrameId(undefined)} />}
    {output && <WorkflowOutputInspector key={JSON.stringify(output)} workflowId={progress.workflowId} programRevision={preview.programRevision} selection={output} onClose={() => setOutput(undefined)} />}
  </div>
}
