import type { WorkflowPlanPreview, WorkflowProgress } from '@shared/workflow'
import { WORKFLOW_MAX_ATTEMPTS } from '@shared/workflow'
import { WORKFLOW_COPY as workflowCopy, WORKFLOW_TEMPLATE_COPY as templateCopy } from '../constants/copy'
import { WORKFLOW_WORKSPACE_COPY as copy } from '../constants/workflow-workspace-copy'
import { WorkflowRecordedSize } from './WorkflowSizePreference'
import { WorkflowSystemPlan } from './WorkflowSystemPlan'

export function WorkflowWorkspacePlan({ preview, progress, onReview, onExtract, onRevise }: {
  preview: WorkflowPlanPreview; progress: WorkflowProgress
  onReview: () => void; onExtract: () => void; onRevise: () => void
}) {
  const fullAccessProviders = [...new Set(preview.program.roles.filter(binding => binding.permissionMode === 'full_access').map(binding => binding.providerId))]
  return <section className="workflow-workspace-plan" aria-label={copy.tabs.plan}>
    <div className="workflow-workspace-plan-heading"><h3>{preview.userGoal}</h3><code>{preview.programRevision}</code></div>
    <p>{workflowCopy.previewNotice}</p><WorkflowRecordedSize value={preview.planningSize} />
    <div className="workflow-workspace-plan-columns">
      <section><h3>{copy.role}</h3><div className="workflow-workspace-table-scroll"><table><thead><tr>
        <th>{copy.role}</th><th>{copy.provider}</th><th>{copy.model}</th><th>{copy.permission}</th>
      </tr></thead><tbody>{preview.program.roles.map(binding => <tr key={binding.role}>
        <th>{workflowCopy.roles[binding.role]}</th><td>{binding.providerId}</td>
        <td>{binding.requestedModel?.id ?? copy.unavailable}</td><td>{binding.permissionMode ?? copy.unavailable}</td>
      </tr>)}</tbody></table></div>
        {fullAccessProviders.length > 0 && <div>
          {fullAccessProviders.map(provider => <p key={provider}>{copy.fullAccess[provider]}</p>)}
          <p>{copy.noSandbox}</p>
        </div>}
        <p>{workflowCopy.experimental}</p>
      </section>
      <section><h3>{copy.plannedCalls}</h3><p>{copy.calls(preview.plannedCalls, WORKFLOW_MAX_ATTEMPTS)}</p>
        <WorkflowSystemPlan preview={preview} /><p>{workflowCopy.budgetNotice}</p><p>{workflowCopy.costNotice}</p>
      </section>
    </div>
    {preview.unavailableReasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
    <time dateTime={new Date(preview.observedAt).toISOString()}>{copy.recordedAt(preview.observedAt)}</time>
    <div className="workflow-actions">
      {progress.state === 'awaiting_approval' && <button type="button" className="primary" data-workflow-workspace-review disabled={preview.state !== 'ready'} onClick={onReview}>{copy.review}</button>}
      {['completed', 'failed', 'blocked', 'stopped'].includes(progress.state) && <button type="button" data-workflow-workspace-revise onClick={onRevise}>{copy.revise}</button>}
      <button type="button" onClick={onExtract}>{templateCopy.extract}</button>
    </div>
    {progress.state !== 'awaiting_approval' && <p>{['completed', 'failed', 'blocked', 'stopped', 'unknown'].includes(progress.state) ? copy.stoppedReview : copy.reviewed}</p>}
  </section>
}
