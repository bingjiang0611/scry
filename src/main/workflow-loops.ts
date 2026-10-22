import type { WorkflowExpression, WorkflowLoopBlock, WorkflowValueSchema } from '../shared/workflow'
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_MAX_BATCH } from '../shared/workflow'
import { workflowLoopCopy as copy } from '../shared/constants/copy'
import { validateWorkflowExpression } from './workflow-expressions'
import { validateWorkflowValueSchema } from './workflow-values'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
function expressions(input: unknown): Record<string, WorkflowExpression> {
  if (!object(input) || !Object.keys(input).length || Object.keys(input).length > WORKFLOW_MAX_BATCH) throw new Error(copy.bindings)
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (!name(key)) throw new Error(copy.bindings)
    return [key, validateWorkflowExpression(value)]
  }))
}

export function validateWorkflowLoop(input: Record<string, unknown>): Omit<WorkflowLoopBlock, 'body'> {
  if (!Number.isSafeInteger(input.maxIterations) || (input.maxIterations as number) < 1 || (input.maxIterations as number) > WORKFLOW_MAX_ATTEMPTS) throw new Error(copy.bounds)
  const initial = expressions(input.initial), invariants = expressions(input.invariants), carry = expressions(input.carry)
  if (!object(input.stateSchema) || JSON.stringify(Object.keys(initial).sort()) !== JSON.stringify(Object.keys(input.stateSchema).sort()) || JSON.stringify(Object.keys(initial).sort()) !== JSON.stringify(Object.keys(carry).sort())) throw new Error(copy.bindings)
  const stateSchema: Record<string, WorkflowValueSchema | 'inferred'> = Object.fromEntries(Object.entries(input.stateSchema).map(([key, value]) => [key, value === 'inferred' ? value : validateWorkflowValueSchema(value)]))
  if (!name(input.outcome) || (input.iteration !== undefined && !name(input.iteration)) || (input.best !== undefined && (typeof input.best !== 'string' || !Object.hasOwn(initial, input.best)))) throw new Error(copy.bindings)
  if (!object(input.policy) || input.policy.error !== 'fail_closed' || input.policy.unknown !== 'block' || input.policy.stop !== 'cancel' || input.policy.logicalExit !== 'report_partial' || Object.keys(input.policy).some(key => !['error', 'unknown', 'stop', 'logicalExit'].includes(key))) throw new Error(copy.policy)
  let progress: WorkflowLoopBlock['progress']
  if (input.progress === 'bounded_only') progress = input.progress
  else {
    if (!object(input.progress) || Object.keys(input.progress).some(key => !['baseline', 'key', 'improved'].includes(key))) throw new Error(copy.contract)
    progress = { baseline: validateWorkflowExpression(input.progress.baseline), key: validateWorkflowExpression(input.progress.key), improved: validateWorkflowExpression(input.progress.improved) }
  }
  return { kind: 'loop', blockId: input.blockId as string, initial, invariants, carry, stateSchema,
    outcome: input.outcome, maxIterations: input.maxIterations as number,
    ...(input.iteration === undefined ? {} : { iteration: input.iteration as string }), ...(input.best === undefined ? {} : { best: input.best as string }),
    until: validateWorkflowExpression(input.until), result: validateWorkflowExpression(input.result), progress,
    policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' } }
}

export const workflowLoopOutcomeSchema: WorkflowValueSchema = { type: 'object', properties: {
  status: { type: 'enum', values: ['success', 'no_progress', 'oscillation', 'exhausted', 'failed', 'blocked', 'unknown', 'stopped'] },
  reasons: { type: 'array', items: { type: 'string' }, maxItems: 8 }, iteration: { type: 'number' }, noProgress: { type: 'number' }
}, required: ['status', 'reasons', 'iteration', 'noProgress'] }
