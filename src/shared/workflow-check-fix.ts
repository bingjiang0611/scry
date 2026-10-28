import type { WorkflowTemplateDefinition } from './workflow-template'
import type { WorkflowCheckRequest } from './workflow-check'
import { WORKFLOW_CHECK_FIX_COPY as copy } from './constants/workflow-check-fix-copy'

/** A project-specific candidate, not an execution or trust grant. Main validates
 * the literal command on save and freezes its authorization during preparation. */
export function workflowCheckFixTemplate(check: WorkflowCheckRequest): Omit<WorkflowTemplateDefinition, 'templateId'> {
  const request = { argv: [...check.argv], cwd: check.cwd, timeoutMs: check.timeoutMs, parser: check.parser }
  return {
    schemaVersion: 1,
    name: copy.title,
    description: copy.description,
    parameters: { goal: { schema: { type: 'string' }, default: copy.goal } },
    roles: [{ role: 'worker' }],
    body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'replica', blockId: 'copy' },
      { kind: 'check', blockId: 'firstCheck', replica: { kind: 'ref', name: 'copy' }, check: request },
      { kind: 'branch', blockId: 'decide',
        when: { kind: 'compare', operator: 'eq', left: { kind: 'field', source: { kind: 'ref', name: 'firstCheck' }, path: ['state'] }, right: { kind: 'literal', value: 'failed' } },
        then: { kind: 'sequence', blockId: 'repairOnce', blocks: [
          { kind: 'call', blockId: 'repair', role: 'worker', prompt: copy.repair,
            replica: { kind: 'ref', name: 'copy' }, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'firstCheck' }] },
          { kind: 'check', blockId: 'secondCheck', replica: { kind: 'ref', name: 'copy' }, check: { ...request, argv: [...request.argv] } }
        ] },
        else: { kind: 'bind', blockId: 'unchanged', value: { kind: 'ref', name: 'firstCheck' } },
        unknown: 'blocked' },
      // Branch values are { arm, value }, not the raw result of the selected arm.
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'decide', path: ['value'] } }
    ] }
  }
}
