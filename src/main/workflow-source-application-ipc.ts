import { templateIdPattern } from '../shared/workflow-template'
import type { WorkflowSourceApplicationCommand } from '../shared/workflow-source-application'
import type { WorkflowSourceApplicationService } from './workflow-source-application-service'

const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new Error('工作流身份无效')
  return value
}

function command(value: unknown): WorkflowSourceApplicationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('源码应用请求无效')
  const input = value as Record<string, unknown>, targetValue = input.target, expectedValue = input.expected, confirmationValue = input.confirmation
  if (Object.keys(input).some(key => !['operationId', 'target', 'expected', 'confirmation'].includes(key)) ||
    typeof input.operationId !== 'string' || !templateIdPattern.test(input.operationId) ||
    !targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue) || !expectedValue || typeof expectedValue !== 'object' || Array.isArray(expectedValue) ||
    !confirmationValue || typeof confirmationValue !== 'object' || Array.isArray(confirmationValue)) throw new Error('源码应用请求无效')
  const target = targetValue as Record<string, unknown>, expected = expectedValue as Record<string, unknown>, confirmation = confirmationValue as Record<string, unknown>
  if (Object.keys(target).some(key => !['workflowId', 'programRevision', 'workflowRevision', 'stepId', 'nodeId'].includes(key)) ||
    typeof target.programRevision !== 'string' || !/^[a-f0-9]{64}$/.test(target.programRevision) || !Number.isSafeInteger(target.workflowRevision) || Number(target.workflowRevision) < 0 ||
    Object.keys(expected).some(key => !['baseHash', 'candidateHash', 'trustFingerprint'].includes(key)) ||
    [expected.baseHash, expected.candidateHash, expected.trustFingerprint].some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
    Object.keys(confirmation).some(key => !['acknowledgesSourceMutation', 'acknowledgesNoAutomaticRollback'].includes(key)) || confirmation.acknowledgesSourceMutation !== true || confirmation.acknowledgesNoAutomaticRollback !== true) throw new Error('源码应用请求无效')
  return { operationId: input.operationId, target: { workflowId: identity(target.workflowId), programRevision: target.programRevision, workflowRevision: Number(target.workflowRevision), stepId: identity(target.stepId), nodeId: identity(target.nodeId) },
    expected: { baseHash: expected.baseHash as string, candidateHash: expected.candidateHash as string, trustFingerprint: expected.trustFingerprint as string },
    confirmation: { acknowledgesSourceMutation: true, acknowledgesNoAutomaticRollback: true } }
}

export function registerWorkflowSourceApplicationIpc(register: (channel: string, listener: (...args: unknown[]) => unknown) => void,
  sourceApplications: Pick<WorkflowSourceApplicationService, 'catalog' | 'apply'>): void {
  register('workflow:sourceApplications', (workflowId, programRevision) => {
    if (typeof programRevision !== 'string' || !/^[a-f0-9]{64}$/.test(programRevision)) throw new Error('源码应用程序版本无效')
    return sourceApplications.catalog(identity(workflowId), programRevision)
  })
  register('workflow:applySourceApplication', value => sourceApplications.apply(command(value)))
}
