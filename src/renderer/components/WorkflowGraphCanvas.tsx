import { useId, useMemo, useRef, useEffect } from 'react'
import type { WorkflowStructureNode } from '../workflow-program-structure'
import type { WorkflowGraphItem } from '../workflow-graph'
import { workflowFlowLayout, WORKFLOW_FLOW_NODE_WIDTH, WORKFLOW_FLOW_NODE_HEIGHT } from '../workflow-flow-layout'
import { WORKFLOW_INSPECTION_COPY as inspection } from '../constants/workflow-inspection-copy'
import { WORKFLOW_WORKSPACE_COPY as copy } from '../constants/workflow-workspace-copy'
import './workflow-flow.css'

function recordedState(items: readonly WorkflowGraphItem[]) {
  if (!items.length) return 'unavailable'
  if (items.some(item => item.state === inspection.missingOutcome)) return 'unknown'
  for (const state of ['unknown', 'failed', 'blocked', 'stopped', 'running', 'dispatched', 'intent_persisted', 'unavailable', 'completed'] as const) {
    if (items.some(item => item.state === state)) return state
  }
  return 'unknown'
}

export function WorkflowGraphCanvas({ nodes, items, selectedId, onSelect, runningNodeIds = [] }: {
  nodes: readonly WorkflowStructureNode[]
  items: readonly WorkflowGraphItem[]
  selectedId: string
  onSelect: (id: string) => void
  runningNodeIds?: readonly string[]
}) {
  const marker = useId()
  const selected = useRef<HTMLButtonElement>(null)
  const layout = useMemo(() => workflowFlowLayout(nodes), [nodes])
  const positions = new Map(layout.nodes.map(node => [node.block.blockId, node]))
  const instances = new Map<string, WorkflowGraphItem[]>()
  for (const item of items) if (item.nodeId) {
    const group = instances.get(item.nodeId) ?? []
    group.push(item)
    instances.set(item.nodeId, group)
  }
  useEffect(() => { selected.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [selectedId])
  return <section className="workflow-flow" aria-label={copy.graph}>
    <div className="workflow-flow-heading"><h3>{copy.graph}</h3><span>{copy.graphSource}</span></div>
    <div className="workflow-flow-viewport" tabIndex={0} role="region" aria-label={copy.graph}>
      <div className="workflow-flow-surface" style={{ width: layout.width, height: layout.height }}>
        <svg data-workflow-flow-edges width={layout.width} height={layout.height} aria-hidden="true">
          <defs><marker id={marker} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" /></marker></defs>
          {layout.edges.map(edge => {
            const from = positions.get(edge.from)!, to = positions.get(edge.to)!
            const x1 = from.x + WORKFLOW_FLOW_NODE_WIDTH, y1 = from.y + WORKFLOW_FLOW_NODE_HEIGHT / 2
            const x2 = to.x, y2 = to.y + WORKFLOW_FLOW_NODE_HEIGHT / 2, middle = (x1 + x2) / 2
            return <path key={edge.to} data-workflow-flow-edge={edge.from + ':' + edge.to} d={`M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`} markerEnd={`url(#${marker})`} />
          })}
        </svg>
        {layout.nodes.map(node => {
          const id = node.block.blockId, group = instances.get(id) ?? []
          const state = runningNodeIds.includes(id) ? 'running' : recordedState(group)
          const stateLabel = state === 'unavailable' && !group.length ? copy.noInstances : inspection.states[state]
          return <button key={id} type="button" ref={id === selectedId ? selected : undefined}
            className="workflow-flow-node" data-workflow-flow-node={id} data-state={state} data-kind={node.block.kind}
            aria-pressed={id === selectedId} aria-label={copy.nodeLabel(id, inspection.kinds[node.block.kind], stateLabel)}
            style={{ left: node.x, top: node.y, width: WORKFLOW_FLOW_NODE_WIDTH, height: WORKFLOW_FLOW_NODE_HEIGHT }} onClick={() => onSelect(id)}>
            <span className="workflow-flow-node-kind">{inspection.kinds[node.block.kind]}</span><code title={id}>{id}</code>
            <span className="workflow-flow-node-state">{stateLabel}{group.length > 0 && <span>{copy.instances(group.length)}</span>}</span>
          </button>
        })}
      </div>
    </div>
    <p className="workflow-flow-source">{copy.instanceSource}</p>
  </section>
}
