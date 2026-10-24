import { createHash } from 'node:crypto'
import type { WorkflowBlock, WorkflowEvaluation } from '../shared/workflow'
import type { WorkflowVerificationInputs } from '../shared/workflow-verification'
import { workflowVerificationCopy as copy } from '../shared/constants/copy'
import type { WorkflowControl, WorkflowControlScope } from './workflow-control'

export const workflowVerificationSelectionHash = (inputs: WorkflowVerificationInputs) => createHash('sha256').update(JSON.stringify({
  checks: Object.entries(inputs.checks).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), ...(inputs.baseline !== undefined ? { baseline: inputs.baseline } : {})
})).digest('hex')
function selector(value: WorkflowEvaluation): string | null {
  return value.state === 'known' && value.value !== null && typeof value.value === 'object' && !Array.isArray(value.value) && typeof value.value.stepId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value.value.stepId) ? value.value.stepId : null
}
export function validateWorkflowVerificationInputs(input: WorkflowVerificationInputs | undefined, block: Extract<WorkflowBlock, { kind: 'verification' }>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'checks' && key !== 'baseline') ||
    !input.checks || typeof input.checks !== 'object' || Array.isArray(input.checks) ||
    JSON.stringify(Object.keys(input.checks).sort()) !== JSON.stringify(Object.keys(block.required).sort()) ||
    Object.values(input.checks).some(value => value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value))) ||
    (block.baseline !== undefined) !== Object.hasOwn(input, 'baseline') || (input.baseline !== undefined && input.baseline !== null && (typeof input.baseline !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(input.baseline)))) throw new Error(copy.contract)
}
export async function evaluateWorkflowVerification(control: WorkflowControl, block: Extract<WorkflowBlock, { kind: 'verification' }>, scope: WorkflowControlScope, stopped: () => boolean): Promise<WorkflowEvaluation> {
  const checks: [string, string | null][] = [], derivedFrom = new Set<string>()
  for (const [key, entry] of Object.entries(block.required)) {
    const value = await control.evaluate(entry.result, scope, block.blockId, stopped)
    if (value.state === 'unknown') return value
    checks.push([key, selector(value)])
    for (const source of value.derivedFrom) derivedFrom.add(source)
  }
  const value: WorkflowVerificationInputs = { checks: Object.fromEntries(checks) }
  if (block.baseline) {
    const baseline = await control.evaluate(block.baseline, scope, block.blockId, stopped)
    if (baseline.state === 'unknown') return baseline
    value.baseline = selector(baseline)
    for (const source of baseline.derivedFrom) derivedFrom.add(source)
  }
  return { state: 'known', value, derivedFrom: [...derivedFrom] }
}
