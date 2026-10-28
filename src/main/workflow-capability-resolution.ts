import type { ProviderDescriptor } from '../shared/provider'
import type { WorkflowCapabilityState, WorkflowRoleBinding } from '../shared/workflow'
import { capabilityForRole, type WorkflowCapabilityRequirement } from './workflow-program'
import type { WorkflowServiceOptions } from './workflow-service-contracts'

type Controls = {
  model: boolean
  stop: boolean
  identity: string
  independentRun: boolean
  terminalOutput: boolean
  structuredCandidateAuthoring: WorkflowCapabilityState
  hostToolsDisabled: WorkflowCapabilityState
  permissionQuestion: WorkflowCapabilityState
  businessQuestion: WorkflowCapabilityState
  waitStates: { model: WorkflowCapabilityState; tool: WorkflowCapabilityState; quota: WorkflowCapabilityState }
}

const unknownControls = (): Controls => ({ model: false, stop: false, identity: '', independentRun: false, terminalOutput: false,
  structuredCandidateAuthoring: 'unknown', hostToolsDisabled: 'unknown', permissionQuestion: 'unknown', businessQuestion: 'unknown', waitStates: { model: 'unknown', tool: 'unknown', quota: 'unknown' } })

export async function resolveWorkflowCapability(options: WorkflowServiceOptions, role: WorkflowRoleBinding, workspace: string,
  required: boolean, requirement: WorkflowCapabilityRequirement) {
  let descriptor: ProviderDescriptor | undefined
  let controls = unknownControls()
  try {
    const snapshot = await options.runControls(role, workspace)
    descriptor = snapshot.descriptor
    controls = { ...snapshot, structuredCandidateAuthoring: snapshot.structuredCandidateAuthoring ?? 'unknown', hostToolsDisabled: snapshot.hostToolsDisabled ?? 'unknown',
      permissionQuestion: snapshot.permissionQuestion ?? 'unknown', businessQuestion: snapshot.businessQuestion ?? 'unknown', waitStates: snapshot.waitStates ?? { model: 'unknown', tool: 'unknown', quota: 'unknown' } }
  } catch { /* refusal, never a replacement Provider */ }
  const capability = capabilityForRole(role, { descriptor, adapterRegistered: options.providerRegistered(role.providerId), requirement,
    hasIndependentRun: controls.model && controls.independentRun && Boolean(controls.identity), canObserveOutput: controls.terminalOutput, canConfirmStop: controls.stop,
    structuredCandidateAuthoring: controls.structuredCandidateAuthoring, hostToolsDisabled: controls.hostToolsDisabled, permissionQuestion: controls.permissionQuestion,
    businessQuestion: controls.businessQuestion, waitStates: controls.waitStates })
  if (required && (!role.runtimeIdentity || role.runtimeIdentity !== controls.identity)) throw new Error('Provider 入口或模型/权限目录已变化，必须重新规划并确认')
  if (required && capability.state !== 'available') throw new Error(`${role.role}: ${capability.reason ?? '能力不可用'}`)
  return { ...capability, runtimeIdentity: controls.identity }
}
