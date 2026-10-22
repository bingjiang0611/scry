import type { WorkflowTemplateApi } from '../shared/workflow-template'

/** register is the production sender/frame/origin wrapper. The store revalidates
 * every scope and payload before reading or mutating its fixed data locations. */
export function registerWorkflowTemplateIpc(register: (channel: string, listener: (...args: unknown[]) => unknown) => void, store: WorkflowTemplateApi): void {
  register('workflow:templates:read', (scope, id) => store.read(scope as Parameters<WorkflowTemplateApi['read']>[0], id as string))
  register('workflow:templates:list', (scope, cursor) => store.list(scope as Parameters<WorkflowTemplateApi['list']>[0], cursor as string | undefined))
  register('workflow:templates:saveDraft', request => store.saveDraft(request as Parameters<WorkflowTemplateApi['saveDraft']>[0]))
  register('workflow:templates:draft', id => store.draft(id as string))
  register('workflow:templates:publish', request => store.publish(request as Parameters<WorkflowTemplateApi['publish']>[0]))
}
