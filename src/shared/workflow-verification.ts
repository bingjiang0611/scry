import type { WorkflowReplicaReference } from './workflow-replica'
import { workflowReplicaValueSchema } from './workflow-system'
import { WORKFLOW_MAX_BATCH, type WorkflowValueSchema } from './workflow'

export const WORKFLOW_MAX_REQUIRED_CHECKS = 64

export type WorkflowVerificationInputs = { checks: Record<string, string | null>; baseline?: string | null }
export type WorkflowNormalizedDiagnostic = { check: string; file: string; code: string; message: string; count: number }
export type WorkflowVerifiedCheck = { key: string; nodeId: string; stepId: string; contractHash: string; passed: boolean }
export type WorkflowVerificationValue = {
  state: 'available' | 'unavailable'
  source: 'main_ledger'
  stepId: string
  selectionHash: string
  reason?: string
  passed?: boolean
  inputHash?: string
  candidate?: WorkflowReplicaReference
  checks?: WorkflowVerifiedCheck[]
  diagnostics?: { state: 'available' | 'unavailable'; source: 'derived'; reason?: string; items?: WorkflowNormalizedDiagnostic[] }
  comparison?: {
    state: 'available' | 'unavailable'
    reason?: string
    regressedChecks?: string[]
    recoveredChecks?: string[]
    diagnostics?: { state: 'available' | 'unavailable'; source: 'derived'; reason?: string; added?: WorkflowNormalizedDiagnostic[]; removed?: WorkflowNormalizedDiagnostic[] }
    progress: { state: 'unavailable'; reason: string }
  }
}
const string: WorkflowValueSchema = { type: 'string' }
const state: WorkflowValueSchema = { type: 'enum', values: ['available', 'unavailable'] }
const strings: WorkflowValueSchema = { type: 'array', items: string, maxItems: WORKFLOW_MAX_BATCH }
const diagnostics: WorkflowValueSchema = { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: { type: 'object', properties: {
  check: string, file: string, code: string, message: string, count: { type: 'number' }
}, required: ['check', 'file', 'code', 'message', 'count'] } }
export const workflowVerificationValueSchema: WorkflowValueSchema = { type: 'object', properties: {
  state, source: { type: 'enum', values: ['main_ledger'] }, stepId: string, selectionHash: string, reason: string,
  passed: { type: 'boolean' }, inputHash: string, candidate: workflowReplicaValueSchema,
  checks: { type: 'array', maxItems: WORKFLOW_MAX_REQUIRED_CHECKS, items: { type: 'object', properties: {
    key: string, nodeId: string, stepId: string, contractHash: string, passed: { type: 'boolean' }
  }, required: ['key', 'nodeId', 'stepId', 'contractHash', 'passed'] } },
  diagnostics: { type: 'object', properties: { state, source: { type: 'enum', values: ['derived'] }, reason: string, items: diagnostics }, required: ['state', 'source'] },
  comparison: { type: 'object', properties: { state, reason: string, regressedChecks: strings, recoveredChecks: strings,
    diagnostics: { type: 'object', properties: { state, source: { type: 'enum', values: ['derived'] }, reason: string, added: diagnostics, removed: diagnostics }, required: ['state', 'source'] },
    progress: { type: 'object', properties: { state: { type: 'enum', values: ['unavailable'] }, reason: string }, required: ['state', 'reason'] }
  }, required: ['state', 'progress'] }
}, required: ['state', 'source', 'stepId', 'selectionHash'] }
