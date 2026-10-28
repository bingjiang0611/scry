import type { WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'
import { WorkflowRolePicker } from './WorkflowRolePicker'

export function WorkflowTemplateBindingForm({ cwd, agents, busy, goal, parameters, bindings, ready, onGoal, onParameters, onBinding, onReady, onEdit, onPrepare }: {
  cwd: string; agents: DetectedAgent[]; busy: boolean; goal: string; parameters: string
  bindings: WorkflowRoleBinding[]; ready: Partial<Record<WorkflowRole, boolean>>
  onGoal: (goal: string) => void; onParameters: (text: string) => void
  onBinding: (binding: WorkflowRoleBinding) => void; onReady: (role: WorkflowRole, ready: boolean) => void
  onEdit: () => void; onPrepare: () => void
}) {
  return <section className="workflow-template-bind"><h3>{copy.bind}</h3>
    <label>{copy.goal}<input disabled={busy} value={goal} onChange={event => onGoal(event.target.value)} maxLength={16000} /></label>
    <label>{copy.parameters}<textarea disabled={busy} aria-label={copy.parameters} value={parameters} onChange={event => onParameters(event.target.value)} spellCheck={false} /></label>
    {bindings.map(binding => <WorkflowRolePicker key={binding.role} binding={binding} agents={agents} cwd={cwd} disabled={busy} onChange={onBinding} onReady={onReady} />)}
    <div className="workflow-actions"><button type="button" disabled={busy} onClick={onEdit}>{copy.edit}</button>
      <button type="button" disabled={busy || !goal.trim() || bindings.some(role => !ready[role.role])} onClick={onPrepare}>{copy.prepare}</button></div>
  </section>
}
