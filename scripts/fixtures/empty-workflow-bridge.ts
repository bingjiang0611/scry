import type { WorkflowApi } from '../../src/shared/workflow-api'

/** Existing full-App fixtures have no workflows. Keep reads honest and fail
 * mutations explicitly rather than adding an optional production preload path. */
const unavailable = async (): Promise<never> => { throw new Error('Workflow execution is disabled in this fixture') }
export const emptyWorkflowBridge: WorkflowApi = {
  sizeGuideline: unavailable,
  setSizeGuideline: unavailable,
  templates: { drafts: async () => ({ drafts: [] }), catalog: async () => ({ templates: [] }), history: async () => ({ revisions: [] }), revision: async () => null, restoreDraft: unavailable, delete: unavailable, read: async () => null, list: async () => ({ templateIds: [] }), saveDraft: unavailable, draft: unavailable, publish: unavailable },
  extractTemplate: unavailable,
  instantiateTemplate: unavailable,
  prepareTemplateTask: unavailable,
  requestTemplateEditCandidate: unavailable,
  applyTemplateEditCandidate: unavailable,
  capturedTasks: unavailable,
  inspectTask: unavailable,
  plan: unavailable,
  preview: unavailable,
  approve: unavailable,
  start: unavailable,
  resume: unavailable,
  retry: unavailable,
  restartStalled: unavailable,
  prepareRevision: unavailable,
  revise: unavailable,
  stop: async () => false,
  stopNode: async () => false,
  cancelPlanning: async () => false,
  snapshot: async () => null,
  inspectExecution: async () => ({ state: 'unavailable', source: 'canonical_ledger', observedAt: Date.now(), reason: 'root_missing' as const }),
  inspectOutput: async () => ({ state: 'unavailable', source: 'canonical_output', observedAt: Date.now(), reason: 'root_missing' as const }),
  sourceApplications: unavailable,
  applySourceApplication: unavailable,
  inspectFrame: async () => ({ state: 'unavailable', source: 'canonical_frame', observedAt: Date.now(), reason: 'root_missing' as const }),
  list: async () => ({ records: [], unresolvedPlanning: 0 }),
  onProgress: () => () => {}
}
