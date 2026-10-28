import { describe, expect, it } from 'vitest'
import { capabilityReady, type ProviderDescriptor, type ProviderId } from '../shared/provider'
import { runtimeProviderForProviderId, type AgentRunControlCatalog } from '../shared/runtime'
import { workflowBindingControls, workflowCapabilityFingerprint } from './workflow-capability'
import { capabilityForRole, validateWorkflowRoleBinding } from './workflow-program'

const execution = { independentRun: true, terminalOutput: true, scopedStop: true, scopeSettlement: true }
const catalog: AgentRunControlCatalog = { models: [
  { model: { id: 'fixture', providerId: 'vendor-not-scry-provider' }, label: 'Fixture', efforts: [] },
  { model: { id: 'another' }, label: 'Another', efforts: [] }
], permissions: [{ id: 'default', label: 'Native approval', description: 'Fixture only' }] }
const descriptor = (id: ProviderId): ProviderDescriptor => ({ id, runtimeProvider: runtimeProviderForProviderId(id), label: id,
  available: true, path: '/fixture/cli', version: 'fixture-1', transport: 'fixture', capabilities: { skills: 'read', commands: 'read', account: 'read', mcp: 'none' } })

describe('workflow fresh-run admission (contract fixtures, no real Provider probe)', () => {
  it.each<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])('admits %s without requiring native continuation identity', providerId => {
    const context = { providerId, cwd: '/fixture' }
    const result = workflowBindingControls({ role: 'worker', providerId, requestedModel: catalog.models[0].model }, context,
      descriptor(providerId), capabilityReady(context, 'read', catalog), execution, true)
    expect(result.model && result.stop && result.independentRun && result.terminalOutput).toBe(true)
    expect(result.identity).toMatch(/^[a-f0-9]{64}$/)
  })
  it('registration, an available descriptor and a matching model do not invent execution features', () => {
    const context = { providerId: 'pi' as const, cwd: '/fixture' }
    const result = workflowBindingControls({ role: 'worker', providerId: 'pi' }, context, descriptor('pi'), capabilityReady(context, 'read', catalog), undefined, true)
    expect(result.model).toBe(true)
    expect(result.independentRun).toBe(false)
    expect(result.terminalOutput).toBe(false)
    expect(result.stop).toBe(false)
  })
  it('rejects a missing vendor/model or native permission, never silently chooses a default', () => {
    const context = { providerId: 'pi' as const, cwd: '/fixture' }
    const base = { role: 'worker' as const, providerId: 'pi' as const }
    const check = (role: typeof base & { requestedModel?: { id: string; providerId?: string }; permissionMode?: 'full_access' }) =>
      workflowBindingControls(role, context, descriptor('pi'), capabilityReady(context, 'read', catalog), execution, true)
    expect(check({ ...base, requestedModel: { id: 'fixture', providerId: 'wrong-vendor' } }).model).toBe(false)
    expect(check({ ...base, requestedModel: { id: 'missing' } }).model).toBe(false)
    expect(check({ ...base, permissionMode: 'full_access' }).model).toBe(false)
  })
  it('ignores list ordering/labels, but binds workspace/profile, entry version and native choices', () => {
    const context = { providerId: 'pi' as const, agentProfileId: 'pi:default', cwd: '/fixture' }
    const original = workflowCapabilityFingerprint(context, descriptor('pi'), catalog, execution)
    expect(workflowCapabilityFingerprint(context, descriptor('pi'), { ...catalog, models: [...catalog.models].reverse().map(option => ({ ...option, label: 'translated' })) }, execution)).toBe(original)
    expect(workflowCapabilityFingerprint({ ...context, cwd: '/private-copy' }, descriptor('pi'), catalog, execution)).not.toBe(original)
    expect(workflowCapabilityFingerprint({ ...context, agentProfileId: 'pi:other' }, descriptor('pi'), catalog, execution)).not.toBe(original)
    expect(workflowCapabilityFingerprint(context, { ...descriptor('pi'), version: 'fixture-2' }, catalog, execution)).not.toBe(original)
    expect(workflowCapabilityFingerprint(context, descriptor('pi'), { ...catalog, models: catalog.models.slice(1) }, execution)).not.toBe(original)
  })
  it('exposes unsupported authoring and wait evidence without promoting it to support', () => {
    const context = { providerId: 'pi' as const, cwd: '/fixture' }
    const result = workflowBindingControls({ role: 'orchestrator', providerId: 'pi' }, context, descriptor('pi'), capabilityReady(context, 'read', catalog), execution, true)
    expect(result.structuredCandidateAuthoring).toBe('unavailable')
    expect(result.hostToolsDisabled).toBe('unavailable')
    expect(result.businessQuestion).toBe('unknown')
    expect(result.waitStates).toEqual({ model: 'unavailable', tool: 'unavailable', quota: 'unavailable' })
  })
  it('does not admit an orchestrator when authoring evidence is unknown', () => {
    const result = capabilityForRole({ role: 'orchestrator', providerId: 'claude' }, {
      descriptor: descriptor('claude'), adapterRegistered: true, hasIndependentRun: true, canObserveOutput: true, canConfirmStop: true
    })
    expect(result.structuredCandidateAuthoring).toBe('unknown')
    expect(result.hostToolsDisabled).toBe('unknown')
    expect(result.state).toBe('unknown')
  })
  it('changes frozen identity when authoring or observation inputs change', () => {
    const context = { providerId: 'claude' as const, cwd: '/fixture' }
    const authoring = { source: 'claude_sdk_success_result' as const, hostTools: 'disabled' as const, permissionBoundary: 'default_only' as const, businessQuestions: 'blocked' as const }
    const first = workflowCapabilityFingerprint(context, descriptor('claude'), catalog, execution, authoring)
    expect(workflowCapabilityFingerprint(context, descriptor('claude'), catalog, { ...execution, observation: { modelProgress: true, tools: true, quotaWait: false } }, authoring)).not.toBe(first)
    expect(workflowCapabilityFingerprint(context, descriptor('claude'), catalog, execution, { ...authoring, businessQuestions: 'blocked' })).toBe(first)
  })
  it('accepts Pi vendor identity distinct from Scry Provider ID, but never ignores a nonconfigured profile', () => {
    expect(validateWorkflowRoleBinding({ role: 'worker', providerId: 'pi', agentProfileId: 'pi:default', requestedModel: catalog.models[0].model }).requestedModel).toEqual(catalog.models[0].model)
    expect(() => validateWorkflowRoleBinding({ role: 'worker', providerId: 'codex', agentProfileId: 'pretend-profile' })).toThrow('不能忽略')
  })
})
