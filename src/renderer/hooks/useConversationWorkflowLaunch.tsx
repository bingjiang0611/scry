import { useEffect, useState } from 'react'
import type { ConversationSubmissionResult } from '@shared/conversation-api'
import type { WorkflowTemplateEditContext } from '@shared/workflow-template'
import type { WorkflowTaskInspection, WorkflowTemplateEditTaskInspection } from '@shared/workflow-api'
import type { WorkflowPlanPreview } from '@shared/workflow'
import { workflowTaskCopy } from '@shared/constants/workflow-task-copy'
import type { DetectedAgent } from '../env'
import type { conversationTarget } from '../conversation-handoff'
import { WorkflowLaunchDialog, workflowLaunchRequest, type WorkflowLaunchRequest } from '../components/WorkflowLaunchDialog'
import { WorkflowTemplateWorkbench } from '../components/WorkflowTemplateWorkbench'
import { WorkflowTemplateTaskDialog, type WorkflowTemplatePreparationRequest } from '../components/WorkflowTemplateTaskDialog'

export function useConversationWorkflowLaunch({ conversationId, cwd, agents, getTarget, onStarted, onError, focusComposer }: {
  conversationId: string
  cwd: string
  agents: DetectedAgent[]
  getTarget: () => ReturnType<typeof conversationTarget>
  onStarted: () => void
  onError: (error: string) => void
  focusComposer: () => void
}) {
  const [workbench, setWorkbench] = useState<{ id: string; preview?: WorkflowPlanPreview; edit?: WorkflowTemplateEditContext;
    editTask?: { reference: WorkflowTaskInspection['task']['reference']; revision: number; selection: import('@shared/workflow-api').WorkflowCapturedTemplateEditTask['selection']; authoring?: Extract<WorkflowTemplateEditTaskInspection['authoring'], { state: 'available' }> }; orchestrator?: WorkflowPlanPreview['orchestrator'] }>()
  const [launch, setLaunch] = useState<WorkflowLaunchRequest>()
  const [template, setTemplate] = useState<WorkflowTemplatePreparationRequest>()
  useEffect(() => { setWorkbench(undefined); setLaunch(undefined); setTemplate(undefined) }, [conversationId])
  const currentOrchestrator = () => {
    const target = getTarget()
    return { role: 'orchestrator' as const, providerId: target.providerId, agentProfileId: target.agentProfileId,
      requestedModel: target.model, permissionMode: target.permissionMode }
  }
  const openCapturedTask = (task: { task?: WorkflowTaskInspection['task']; command: string; workspace: string; submission: WorkflowTaskInspection['submission']; edit?: WorkflowTemplateEditContext;
    authoring?: WorkflowTemplateEditTaskInspection['authoring'] }) => {
    if ('editCommandId' in task.submission) {
      if (!task.edit) throw new Error(workflowTaskCopy.editMissing)
      if (!task.task) throw new Error(workflowTaskCopy.editMissing)
      setWorkbench({ id: task.submission.editCommandId, edit: task.edit, orchestrator: currentOrchestrator(),
        editTask: { reference: task.task.reference, revision: task.task.revision, selection: task.submission.selection,
          ...(task.authoring?.state === 'available' ? { authoring: task.authoring } : {}) } })
      return
    }
    if ('instanceCommandId' in task.submission) {
      setTemplate({ command: task.command, cwd: task.workspace, submission: task.submission })
      return
    }
    setLaunch({ id: task.submission.planningCommandId, command: task.command, cwd: task.workspace,
      submission: task.submission, orchestrator: currentOrchestrator() })
  }
  const onControl = (result: Extract<ConversationSubmissionResult, { kind: 'control' }>) => {
    if (result.action === 'edit_workflow_template') setWorkbench({ id: result.submission.editCommandId, edit: result.edit, orchestrator: currentOrchestrator(),
      editTask: { reference: result.submission.reference, revision: 0, selection: result.submission.selection } })
    else if (result.action === 'open_workflows') setWorkbench({ id: crypto.randomUUID() })
    else if (result.action === 'open_workflow_planner' || result.action === 'open_workflow_template') openCapturedTask(result)
    // A routed draft is already persisted: open the same approval dialog directly,
    // without a second planning call and without auto-approving execution.
    else if (result.action === 'open_workflow_routed') setLaunch(workflowLaunchRequest(result.preview))
  }
  const dialogs = <>
    {workbench && <WorkflowTemplateWorkbench key={workbench.id} cwd={cwd} agents={agents}
      initialEdit={workbench.edit} editTask={workbench.editTask} sourcePreview={workbench.preview} orchestrator={workbench.orchestrator ?? workbench.preview?.orchestrator}
      onClose={() => setWorkbench(undefined)} onPrepared={preview => {
        setLaunch(workflowLaunchRequest(preview)); setWorkbench(undefined)
      }} />}
    {template && !workbench && <WorkflowTemplateTaskDialog key={template.submission.instanceCommandId}
      request={template} agents={agents} onDismiss={() => { setTemplate(undefined); requestAnimationFrame(focusComposer) }}
      onPrepared={request => { setTemplate(undefined); setLaunch(request) }} />}
    {launch && !workbench && !template && <WorkflowLaunchDialog key={launch.id} request={launch} agents={agents}
      onDismiss={() => setLaunch(undefined)} onStarted={onStarted} onError={onError}
      onEdit={preview => setWorkbench({ id: crypto.randomUUID(), preview })} />}
  </>
  return { openCapturedTask, onPreview: setLaunch, onControl, dialogs }
}
