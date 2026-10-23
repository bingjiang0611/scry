import type { WorkflowApi } from '../../src/shared/workflow-api'

/** Existing full-App fixtures have no workflows. Keep reads honest and fail
 * mutations explicitly rather than adding an optional production preload path. */
const unavailable = async (): Promise<never> => { throw new Error('Workflow execution is disabled in this fixture') }
export const emptyWorkflowBridge: WorkflowApi = {
  templates: { read: async () => null, list: async () => ({ templateIds: [] }), saveDraft: unavailable, draft: unavailable, publish: unavailable },
  instantiateTemplate: unavailable,
  plan: unavailable,
  preview: unavailable,
  approve: unavailable,
  start: unavailable,
  resume: unavailable,
  stop: async () => false,
  cancelPlanning: async () => false,
  snapshot: async () => null,
  list: async () => ({ records: [], unresolvedPlanning: 0 }),
  onProgress: () => () => {}
}
