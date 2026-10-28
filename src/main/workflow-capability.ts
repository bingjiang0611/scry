import { createHash } from 'node:crypto'
import type { CapabilityEnvelope, ProviderContext, ProviderDescriptor } from '../shared/provider'
import type { ProviderAdapter } from './providers/types'
import type { AgentRunControlCatalog } from '../shared/runtime'
import type { WorkflowRoleBinding } from '../shared/workflow'

/** Catalog membership alone never establishes fresh-session/stop semantics. */
export function workflowBindingControls(role: WorkflowRoleBinding, context: ProviderContext,
  descriptor: ProviderDescriptor, envelope: CapabilityEnvelope<AgentRunControlCatalog>,
  execution: ProviderAdapter['workflowExecution'], enabled: boolean,
  authoring?: ProviderAdapter['workflowAuthoring']) {
  const unavailable = { structuredCandidateAuthoring: authoring ? 'unavailable' as const : 'unknown' as const,
    hostToolsDisabled: authoring ? 'unavailable' as const : 'unknown' as const,
    permissionQuestion: 'unknown' as const, businessQuestion: 'unknown' as const,
    waitStates: { model: 'unknown' as const, tool: 'unknown' as const, quota: 'unknown' as const } }
  if (!enabled || envelope.state !== 'ready' || !envelope.data || !descriptor.available) {
    return { descriptor, model: false, stop: false, identity: '', independentRun: false, terminalOutput: false, ...unavailable }
  }
  const catalog = envelope.data
  const requested = role.requestedModel
  const model = requested
    ? catalog.models.some(option => option.model.id === requested.id && (!requested.providerId || option.model.providerId === requested.providerId))
    : catalog.models.length > 0
  const permission = catalog.permissions.some(option => option.id === (role.permissionMode ?? 'default'))
  const observation = execution?.observation
  return { descriptor, model: model && permission, stop: execution?.scopedStop === true && execution.scopeSettlement,
    independentRun: execution?.independentRun === true, terminalOutput: execution?.terminalOutput === true,
    identity: workflowCapabilityFingerprint(context, descriptor, catalog, execution, authoring),
    structuredCandidateAuthoring: authoring ? 'available' as const : 'unavailable' as const,
    hostToolsDisabled: authoring?.hostTools === 'disabled' ? 'available' as const : 'unavailable' as const,
    permissionQuestion: execution?.permissionQuestion === true ? 'available' as const : execution?.permissionQuestion === false ? 'unavailable' as const : 'unknown' as const,
    businessQuestion: authoring?.businessQuestions === 'blocked' ? 'unavailable' as const : 'unknown' as const,
    waitStates: { model: observation?.modelProgress ? 'available' as const : 'unavailable' as const,
      tool: observation?.tools ? 'available' as const : 'unavailable' as const,
      quota: observation?.quotaWait ? 'available' as const : 'unavailable' as const } }
}

/** Fresh-run capability snapshot, NOT a native resume/account identity.
 * Credential namespaces are neither saved nor inferred here. Native permission,
 * executable/config trust and process ownership remain in the App start chain.
 * All registered Providers can supply this without pretending resume parity.
 */
export function workflowCapabilityFingerprint(
  context: ProviderContext,
  descriptor: ProviderDescriptor,
  catalog: AgentRunControlCatalog,
  execution?: ProviderAdapter['workflowExecution'],
  authoring?: ProviderAdapter['workflowAuthoring']
): string {
  const models = catalog.models.map(option => ({ model: { id: option.model.id, providerId: option.model.providerId }, isDefault: option.isDefault ?? false,
    efforts: option.efforts.map(effort => [effort.id, effort.isDefault ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }))
    .sort((a, b) => JSON.stringify(a.model).localeCompare(JSON.stringify(b.model)))
  return createHash('sha256').update(JSON.stringify({ providerId: context.providerId, profile: context.agentProfileId,
    cwd: context.cwd, runtimeProvider: descriptor.runtimeProvider, path: descriptor.path, version: descriptor.version,
    transport: descriptor.transport, execution, authoring, models, permissions: catalog.permissions.map(permission => permission.id).sort() })).digest('hex')
}
