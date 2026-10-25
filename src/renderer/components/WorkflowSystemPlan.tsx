import { useMemo, useState } from 'react'
import type { WorkflowBlock, WorkflowPlanPreview } from '@shared/workflow'
import { workflowChildBlocks } from '@shared/workflow'
import { WORKFLOW_COPY as copy } from '../constants/copy'

export function WorkflowSystemPlan({ preview }: { preview: WorkflowPlanPreview }) {
  const [page, setPage] = useState(0)
  const steps = useMemo(() => {
    const pending = [preview.program.body], result: Extract<WorkflowBlock, { kind: 'replica' | 'check' | 'call' }>[] = []
    while (pending.length) {
      const block = pending.pop()!
      if (block.kind === 'replica' || block.kind === 'check' || (block.kind === 'call' && block.replica)) result.push(block)
      pending.push(...workflowChildBlocks(block).reverse())
    }
    return result
  }, [preview])
  if (!steps.length) return null
  const pages = Math.ceil(steps.length / 16)
  return <section className="workflow-system-plan" aria-label={copy.systemPlan}>
    <h3>{copy.systemPlan}</h3>
    {steps.some(step => step.kind === 'check') && <p>{copy.checkExecutionNotice}</p>}
    {steps.some(step => step.kind === 'call') && <p>{copy.replicaAgentExecutionNotice}</p>}
    <p>{copy.systemPlanCount(steps.length)}</p>
    {steps.slice(page * 16, page * 16 + 16).map(step => <div key={step.blockId} data-workflow-system-node={step.blockId}>
      <h4>{step.blockId} · {step.kind === 'call' ? copy.replicaAgentKind : copy.systemKind[step.kind === 'replica' ? 'prepare_replica' : 'check']}</h4>
      <dl>
        <dt>{copy.systemTarget}</dt><dd><code>{JSON.stringify(step.kind === 'replica' ? step.source ?? preview.workspace : step.replica)}</code></dd>
        {step.kind === 'check' && <>
          <dt>{copy.systemArgv}</dt><dd><code>{JSON.stringify(step.check.argv)}</code></dd>
          <dt>{copy.systemCwd}</dt><dd><code>{step.check.cwd}</code></dd>
          <dt>{copy.systemTimeout}</dt><dd>{step.check.timeoutMs}</dd>
          <dt>{copy.systemParser}</dt><dd><code>{step.check.parser}</code></dd>
        </>}
      </dl>
    </div>)}
    {pages > 1 && <nav aria-label={copy.systemPlanPages}>
      <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{copy.previousPage}</button>
      <span>{copy.systemPage(page + 1, pages)}</span>
      <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>{copy.nextPage}</button>
    </nav>}
  </section>
}
