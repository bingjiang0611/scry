import type { WorkflowValue } from '../shared/workflow'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import { workflowCheckValueSchema, type WorkflowCheckSummary } from '../shared/workflow-system'
import { workflowVerificationCopy as copy } from '../shared/constants/copy'
import type { WorkflowStore } from './workflow-store'
import { nodeTestReportState, parseNodeTestTap } from './workflow-node-test-tap'
import { matchesWorkflowValue } from './workflow-values'

/** Tie consumed native facts to the main receipt and its immutable output.
 * Counts are recomputed from stdout, not trusted because two JSON fields agree.
 * Human-readable limitation reasons are not versioned authority identifiers. */
export async function verifyWorkflowCheckValue(store: WorkflowStore, workflowId: string, stepId: string, check: WorkflowCheckSummary, authorization: WorkflowFrozenCheck, raw: WorkflowValue) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' || raw.stepId !== stepId || raw.passed !== (check.state === 'passed') || raw.state !== check.state || raw.exitCode !== check.exitCode || raw.settled !== check.settled || raw.truncated !== check.truncated || JSON.stringify(raw.tests) !== JSON.stringify(check.tests)) throw new Error(copy.contract)
  if (authorization.parser === 'node_test') {
    const stdout = await store.loadValue(workflowId, check.stdoutRef)
    if (stdout.state !== 'known' || typeof stdout.value !== 'string' || !matchesWorkflowValue(raw, workflowCheckValueSchema)) throw new Error(copy.contract)
    const observed = parseNodeTestTap(stdout.value, check.truncated)
    if (observed.state !== check.tests?.state || (observed.state === 'available' && (check.tests?.state !== 'available' || JSON.stringify(observed.counts) !== JSON.stringify(check.tests.counts))) || (check.state === 'passed' && (check.exitCode !== 0 || nodeTestReportState(observed) !== 'passed'))) throw new Error(copy.contract)
  } else if (check.tests !== undefined) throw new Error(copy.contract)
  return raw
}
