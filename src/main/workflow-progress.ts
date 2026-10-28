import type { WorkflowPlanPreview, WorkflowProgress } from '../shared/workflow'
import type { WorkflowIntent, WorkflowStoreRecord } from './workflow-store'

export function workflowIntentFrameId(intent: Pick<WorkflowIntent, 'frameId' | 'callFrameId'>): string | undefined {
  return intent.frameId ?? intent.callFrameId
}

/** Initial execution projection retains the original root budget and evidence. */
export function initialWorkflowProgress(preview: WorkflowPlanPreview, slots: WorkflowProgress['slots'], updatedAt: number, previous?: WorkflowStoreRecord): WorkflowProgress {
  return {
    workflowId: preview.workflowId, programRevision: preview.programRevision, workspace: preview.workspace,
    ...(preview.planningSize ? { planningSize: preview.planningSize } : {}),
    goal: preview.userGoal, state: 'queued', attempts: previous ? [...previous.outcomes] : [], dispatchAttempts: previous?.progress.dispatchAttempts ?? 0,
    ...(previous?.progress.systemSteps ? { systemSteps: structuredClone(previous.progress.systemSteps) } : {}),
    slots, updatedAt
  }
}

/** Project frame identity from the canonical admission ledgers into bounded
 * progress rows. Outcomes remain immutable facts and never gain view metadata. */
export function projectWorkflowFrameLinks(progress: WorkflowProgress, record: WorkflowStoreRecord | undefined): WorkflowProgress {
  if (!record) return progress
  const attempts = new Map(record.intents.map(intent => [intent.attemptId, workflowIntentFrameId(intent)]))
  const systems = new Map((record.systemIntents ?? []).map(intent => [intent.stepId, intent.frameId]))
  return {
    ...progress,
    ...(record.preview.planningSize ? { planningSize: record.preview.planningSize } : {}),
    attempts: progress.attempts.map(({ frameId: _frameId, ...attempt }) => {
      const frameId = attempts.get(attempt.attemptId)
      return frameId ? { ...attempt, frameId } : attempt
    }),
    ...(progress.systemSteps ? { systemSteps: progress.systemSteps.map(({ frameId: _frameId, ...step }) => {
      const frameId = systems.get(step.stepId)
      return frameId ? { ...step, frameId } : step
    }) } : {})
  }
}
