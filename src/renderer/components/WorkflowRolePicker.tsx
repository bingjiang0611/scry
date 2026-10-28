import { useEffect, useRef, useState } from 'react'
import type { AgentRunControlCatalog } from '@shared/runtime'
import type { CapabilityEnvelope, ProviderContext } from '@shared/provider'
import { providerIdForAgentId } from '@shared/runtime'
import type { WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY as copy } from '../constants/copy'

const modelKey = (model: { id: string; providerId?: string }) => JSON.stringify([model.providerId ?? '', model.id])
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const catalogsInFlight = new Map<string, Promise<CapabilityEnvelope<AgentRunControlCatalog>>>()
function readRoleControls(context: ProviderContext) {
  const read = window.scry.runControls
  if (!read) return Promise.reject(new Error(copy.configurationUnavailable))
  const key = JSON.stringify(context)
  const existing = catalogsInFlight.get(key)
  if (existing) return existing
  if (catalogsInFlight.size >= 128) return Promise.reject(new Error(copy.configurationUnavailable))
  const result = read(context)
  catalogsInFlight.set(key, result)
  const clear = () => { if (catalogsInFlight.get(key) === result) catalogsInFlight.delete(key) }
  void result.then(clear, clear)
  return result
}

export function WorkflowProviderSelect({ role, agents, selected = '', onChange }: {
  role: WorkflowRole
  agents: DetectedAgent[]
  selected?: string
  onChange: (binding: WorkflowRoleBinding) => void
}) {
  return <label>{copy.provider}<select value={selected} onChange={event => {
    const agent = agents.find(candidate => candidate.id === event.target.value)
    const providerId = agent && providerIdForAgentId(agent.id)
    if (!agent || !providerId) return
    onChange({ role, providerId, ...(providerId === 'pi' ? { agentProfileId: agent.id } : {}), permissionMode: 'default' })
  }}>
    {!selected && <option value="" disabled>{agents.length ? copy.chooseProvider : copy.emptyAgents}</option>}
    {agents.map(agent => <option key={agent.id} value={agent.id} disabled={Boolean(agent.unavailableReason) || !providerIdForAgentId(agent.id)}>{agent.name}</option>)}
  </select></label>
}

export function WorkflowRolePicker({ binding, agents, cwd, disabled, lockDefaultPermission = false, onChange, onReady }: {
  binding: WorkflowRoleBinding
  agents: DetectedAgent[]
  cwd: string
  disabled: boolean
  lockDefaultPermission?: boolean
  onChange: (binding: WorkflowRoleBinding) => void
  onReady: (role: WorkflowRole, ready: boolean) => void
}) {
  const catalogKey = JSON.stringify([binding.providerId, binding.agentProfileId, cwd])
  const [catalogState, setCatalog] = useState<{ key: string; data: AgentRunControlCatalog } | null>(null)
  const catalog = catalogState?.key === catalogKey ? catalogState.data : null
  const [error, setError] = useState<string | null>(null)
  // Catalog reads are bounded by the four role rows; a stale reply never
  // changes a newer Provider/profile selection.
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  useEffect(() => {
    let current = true
    setCatalog(null)
    setError(null)
    readyRef.current(binding.role, false)
    void readRoleControls({ providerId: binding.providerId, agentProfileId: binding.agentProfileId, cwd }).then(result => {
      if (!current) return
      if (!result.data || result.state !== 'ready') throw new Error(result.reason ?? copy.configurationUnavailable)
      setCatalog({ key: catalogKey, data: result.data })
    }).catch(error => { if (current) setError(message(error)) })
    return () => { current = false }
  }, [binding.role, binding.providerId, binding.agentProfileId, cwd])
  const selected = agents.find(agent => providerIdForAgentId(agent.id) === binding.providerId &&
    (binding.providerId !== 'pi' || agent.id === binding.agentProfileId))?.id ?? ''
  const modelAvailable = Boolean(catalog && (binding.requestedModel
    ? catalog.models.some(option => modelKey(option.model) === modelKey(binding.requestedModel!)) : catalog.models.length > 0))
  const permissionMode = lockDefaultPermission ? 'default' : binding.permissionMode ?? 'default'
  const permissionAvailable = Boolean(catalog?.permissions.some(option => option.id === permissionMode))
  const valid = Boolean(selected && modelAvailable && permissionAvailable)
  useEffect(() => { readyRef.current(binding.role, valid) }, [binding.role, binding.providerId, binding.agentProfileId,
    binding.requestedModel?.id, binding.requestedModel?.providerId, permissionMode, valid])
  return <fieldset className="workflow-role" data-workflow-role={binding.role} disabled={disabled}>
    <legend>{copy.roles[binding.role]}</legend>
    <WorkflowProviderSelect role={binding.role} agents={agents} selected={selected} onChange={onChange} />
    <label>{copy.model}<select disabled={!catalog} value={binding.requestedModel ? modelKey(binding.requestedModel) : ''} onChange={event => {
      const model = catalog?.models.find(option => modelKey(option.model) === event.target.value)?.model
      onChange({ ...binding, requestedModel: model })
    }}>
      {binding.requestedModel && !modelAvailable && <option value={modelKey(binding.requestedModel)} disabled>{copy.selectedModelUnavailable}</option>}
      <option value="">{catalog ? copy.providerDefault : copy.loading}</option>
      {catalog?.models.map(option => <option key={modelKey(option.model)} value={modelKey(option.model)}>{option.label}</option>)}
    </select></label>
    {!lockDefaultPermission && <label>{copy.permission}<select disabled={!catalog} value={permissionMode} onChange={event => {
      const nextPermission = catalog?.permissions.find(option => option.id === event.target.value)?.id
      if (nextPermission) onChange({ ...binding, permissionMode: nextPermission })
    }}>
      {!permissionAvailable && <option value={permissionMode} disabled>{catalog ? copy.selectedPermissionUnavailable : copy.loading}</option>}
      {catalog?.permissions.map(option => <option key={option.id} value={option.id} title={option.description}>{option.label}</option>)}
    </select></label>}
    {catalog && <p>{catalog.permissions.find(option => option.id === permissionMode)?.description}</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>
}
