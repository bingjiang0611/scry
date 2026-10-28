import { useEffect, useId, useRef, useState } from 'react'
import type { WorkflowPlanPreview } from '@shared/workflow'
import type { WorkflowExecutionInspectionKind } from '@shared/workflow-inspection'
import type { WorkflowOutputSelection } from '@shared/workflow-output-inspection'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'
import { workflowProgramStructure, workflowInspectionKind } from '../workflow-program-structure'
import { ModalFrame } from './Modals'
import { WorkflowExecutionHistory } from './WorkflowExecutionHistory'
import { WorkflowExecutionGraph } from './WorkflowExecutionGraph'
import { WorkflowFrameInspector } from './WorkflowFrameInspector'
import { WorkflowOutputInspector } from './WorkflowOutputInspector'
import './workflow-inspection.css'

type Source = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; preview: WorkflowPlanPreview; nodes: ReturnType<typeof workflowProgramStructure> }
const STRUCTURE_PAGE_SIZE = 32

export function WorkflowExecutionInspector({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [sequence, setSequence] = useState(0)
  const [source, setSource] = useState<Source>({ state: 'loading' })
  const [view, setView] = useState<'program' | 'history' | 'graph'>('program')
  const [selected, setSelected] = useState(0)
  const [page, setPage] = useState(0)
  const [nodeId, setNodeId] = useState<string>()
  const [kind, setKind] = useState<WorkflowExecutionInspectionKind>('attempts')
  const [frameId, setFrameId] = useState<string>()
  const [output, setOutput] = useState<WorkflowOutputSelection>()
  useEffect(() => {
    let current = true
    void window.scry.workflow.preview(workflowId).then(preview => {
      if (current) {
        setSource({ state: 'ready', preview, nodes: workflowProgramStructure(preview.program.body) })
        setSelected(0); setPage(0); setNodeId(undefined); setFrameId(undefined); setOutput(undefined)
      }
    }).catch(error => { if (current) setSource({ state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [workflowId, sequence])
  const reload = () => {
    heading.current?.focus()
    setSource({ state: 'loading' })
    setSequence(value => value + 1)
  }
  const history = (filter?: string) => { setNodeId(filter); setView('history') }
  const move = (next: number) => { heading.current?.focus(); setPage(next) }
  return <ModalFrame labelledBy={titleId} className="workflow-execution-inspector" onClose={onClose}>
    <header><h2 id={titleId} ref={heading} tabIndex={-1}>{copy.title}</h2><button type="button" data-workflow-inspection-action="close" onClick={onClose}>{copy.close}</button></header>
    <nav aria-label={copy.title}>
      <button type="button" data-workflow-inspection-tab="program" aria-pressed={view === 'program'} onClick={() => setView('program')}>{copy.program}</button>
      <button type="button" data-workflow-inspection-tab="history" aria-pressed={view === 'history'} onClick={() => history()}>{copy.history}</button>
      <button type="button" data-workflow-inspection-tab="graph" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>{copy.graph}</button>
      <button type="button" data-workflow-inspection-action="reload" disabled={source.state === 'loading'} onClick={reload}>{copy.refresh}</button>
    </nav>
    {source.state === 'loading' && <p role="status">{copy.loading}</p>}
    {source.state === 'error' && <p role="alert">{source.message}</p>}
    {source.state === 'ready' && <>
      <code className="workflow-inspection-revision" data-workflow-inspection-source={source.preview.programRevision}>{source.preview.programRevision}</code>
      {view === 'program' ? <>
        <p>{copy.source}</p>
        <div className="workflow-program-and-code">
          <section aria-label={copy.program}>
            <ol className="workflow-program-structure">{source.nodes.slice(page * STRUCTURE_PAGE_SIZE, (page + 1) * STRUCTURE_PAGE_SIZE).map((node, index) => <li key={node.block.blockId}>
              <button type="button" data-workflow-program-node={node.block.blockId} data-workflow-program-parent={node.parentId}
                aria-pressed={selected === page * STRUCTURE_PAGE_SIZE + index} style={{ paddingInlineStart: 8 + Math.min(node.depth, 6) * 12 }}
                onClick={() => setSelected(page * STRUCTURE_PAGE_SIZE + index)}>
                <span>{copy.kinds[node.block.kind]}</span><code>{node.block.blockId}</code>
              </button>
            </li>)}</ol>
            <p>{copy.structurePage(page * STRUCTURE_PAGE_SIZE + 1, Math.min((page + 1) * STRUCTURE_PAGE_SIZE, source.nodes.length), source.nodes.length)}</p>
            <div className="workflow-inspection-pagination">
              <button type="button" data-workflow-program-page="previous" disabled={page === 0} onClick={() => move(page - 1)}>{copy.previous}</button>
              <button type="button" data-workflow-program-page="next" disabled={(page + 1) * STRUCTURE_PAGE_SIZE >= source.nodes.length} onClick={() => move(page + 1)}>{copy.next}</button>
            </div>
          </section>
          <section className="workflow-program-code">
            <label htmlFor={`${titleId}-code`}>{copy.code}<code>{source.nodes[selected].block.blockId}</code></label>
            <textarea id={`${titleId}-code`} readOnly spellCheck={false} value={JSON.stringify(source.nodes[selected].block, null, 2)} />
            <button type="button" data-workflow-inspection-action="node-history" onClick={() => {
              const block = source.nodes[selected].block
              setKind(workflowInspectionKind(block))
              history(block.blockId)
            }}>{copy.inspectNode}</button>
          </section>
        </div>
      </> : view === 'history' ? <>
        {nodeId && <p><code>{nodeId}</code><span>{copy.exactFilter}</span><button type="button" data-workflow-inspection-action="all-nodes" onClick={() => setNodeId(undefined)}>{copy.allNodes}</button></p>}
        <div className="workflow-inspection-kinds">
          <button type="button" data-workflow-inspection-kind="attempts" aria-pressed={kind === 'attempts'} onClick={() => setKind('attempts')}>{copy.attempts}</button>
          <button type="button" data-workflow-inspection-kind="systems" aria-pressed={kind === 'systems'} onClick={() => setKind('systems')}>{copy.systems}</button>
          <button type="button" data-workflow-inspection-kind="classifiers" aria-pressed={kind === 'classifiers'} onClick={() => setKind('classifiers')}>{copy.classifiers}</button>
        </div>
        <WorkflowExecutionHistory key={`${source.preview.programRevision}:${nodeId ?? ''}:${kind}`} workflowId={workflowId}
          programRevision={source.preview.programRevision} nodeId={nodeId} kind={kind} onFrame={setFrameId} onOutput={setOutput} onReloadSource={reload} />
      </> : <WorkflowExecutionGraph workflowId={workflowId} preview={source.preview} onFrame={setFrameId} onOutput={setOutput} />}
    </>}
    {frameId && source.state === 'ready' && <WorkflowFrameInspector workflowId={workflowId} frameId={frameId} programRevision={source.preview.programRevision} onClose={() => setFrameId(undefined)} />}
    {output && source.state === 'ready' && <WorkflowOutputInspector key={`${workflowId}:${source.preview.programRevision}:${JSON.stringify(output)}`} workflowId={workflowId} programRevision={source.preview.programRevision} selection={output} onClose={() => setOutput(undefined)} />}
  </ModalFrame>
}
