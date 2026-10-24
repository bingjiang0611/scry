import type { ProviderId } from './provider.js'
import { parseWorkspaceStartSelection } from './workspace-selection-input.js'
import { boundedControlValue, normalizeAgentAttachments } from './runtime-input.js'
import { isAgentPermissionMode } from './runtime-types.js'
import type { AgentForkSessionRequest, AgentStartRequest, NormalizedAgentStartRequest, RuntimeProvider } from './runtime-types.js'

export function runtimeProviderForAgentId(agentId: string | undefined): RuntimeProvider | undefined {
  if (!agentId || agentId === 'claude') return 'claude_sdk'
  if (agentId === 'codex') return 'codex_cli'
  if (agentId === 'qoder') return 'qoder_cli'
  if (agentId === 'opencode') return 'opencode_server'
  if (agentId === 'pi' || agentId.startsWith('pi:')) return 'pi_rpc'
  return undefined
}

export function providerIdForAgentId(agentId: string | undefined): ProviderId | undefined {
  if (!agentId) return undefined
  if (agentId === 'claude') return 'claude'
  if (agentId === 'codex' || agentId === 'qoder' || agentId === 'opencode') return agentId
  if (agentId === 'pi' || agentId.startsWith('pi:')) return 'pi'
  return undefined
}

export function providerIdForRuntime(runtimeProvider: RuntimeProvider): ProviderId {
  if (runtimeProvider === 'codex_cli') return 'codex'
  if (runtimeProvider === 'qoder_cli') return 'qoder'
  if (runtimeProvider === 'opencode_server') return 'opencode'
  if (runtimeProvider === 'pi_rpc') return 'pi'
  return 'claude'
}

export function runtimeProviderForProviderId(providerId: ProviderId): RuntimeProvider {
  if (providerId === 'codex') return 'codex_cli'
  if (providerId === 'qoder') return 'qoder_cli'
  if (providerId === 'opencode') return 'opencode_server'
  if (providerId === 'pi') return 'pi_rpc'
  return 'claude_sdk'
}

const COMMAND_ID_PATTERN = /^[A-Za-z0-9_:-]{8,128}$/

/** 命令标识的合同：足够长以避免碰撞，字符集足够窄以安全地做 Map 键与日志字段。 */
export function isCommandId(value: string): boolean {
  return COMMAND_ID_PATTERN.test(value)
}

export function normalizeAgentStartRequest(payload: AgentStartRequest): NormalizedAgentStartRequest {
  const explicitAgentId = payload.agentId?.trim()
  const mappedProviderId = providerIdForAgentId(explicitAgentId)
  if (explicitAgentId && !mappedProviderId && !payload.providerId) {
    throw new Error(`agent=${explicitAgentId} 尚未注册 Provider adapter`)
  }
  if (payload.providerId && mappedProviderId && payload.providerId !== mappedProviderId) {
    throw new Error(`provider=${payload.providerId} 与 agent=${explicitAgentId} 不匹配`)
  }
  const providerId = payload.providerId ?? mappedProviderId ?? 'claude'
  const agentId = explicitAgentId ?? providerId
  const agentProfileId = boundedControlValue(payload.agentProfileId) ??
    (providerId === 'pi' && explicitAgentId?.startsWith('pi:') ? explicitAgentId : undefined)
  if (providerId === 'pi' && !agentProfileId) {
    throw new Error('Pi Provider 缺少 agentProfileId')
  }
  const expectedRuntime = runtimeProviderForProviderId(providerId)
  const modelId = boundedControlValue(payload.model?.id)
  const modelProviderId = boundedControlValue(payload.model?.providerId)
  const effort = boundedControlValue(payload.effort)
  if (payload.networkLabel !== undefined && (typeof payload.networkLabel !== 'string' || payload.networkLabel.trim().length > 80)) {
    throw new Error('网络标签必须是最多 80 个字符的文本')
  }
  const networkLabel = payload.networkLabel?.trim()
  const commandId = payload.commandId?.trim()
  if (commandId !== undefined && !isCommandId(commandId)) {
    throw new Error('commandId 必须是 8-128 个字符的 [A-Za-z0-9_:-]')
  }
  const permissionMode = payload.permissionMode ?? 'default'
  if (!isAgentPermissionMode(permissionMode)) {
    throw new Error(`permissionMode=${String(permissionMode)} 不受支持`)
  }
  const replaceRunId = boundedControlValue(payload.forkLastTurn?.replaceRunId)
  const replaceProviderTurnId = boundedControlValue(payload.forkLastTurn?.replaceProviderTurnId)
  const replaceForkTurnId = boundedControlValue(payload.forkLastTurn?.replaceForkTurnId)
  const previousProviderTurnId = boundedControlValue(payload.forkLastTurn?.previousProviderTurnId)
  const previousForkTurnId = boundedControlValue(payload.forkLastTurn?.previousForkTurnId)
  const restartReplaceRunId = boundedControlValue(payload.restartLastTurn?.replaceRunId)
  if (payload.forkLastTurn && payload.restartLastTurn) {
    throw new Error('编辑最后一条消息不能同时请求分支与重新开始')
  }
  if (payload.forkLastTurn && (!replaceRunId || !replaceProviderTurnId || !replaceForkTurnId || typeof payload.expectedExternalSessionId !== 'string')) {
    throw new Error('编辑最后一条消息缺少可信会话或轮次边界')
  }
  if (payload.restartLastTurn && (!restartReplaceRunId || typeof payload.expectedExternalSessionId !== 'string')) {
    throw new Error('重新编辑首轮消息缺少可信会话或 run 边界')
  }
  if (payload.workspace !== undefined && (!commandId || payload.expectedExternalSessionId !== null ||
    payload.forkLastTurn || payload.restartLastTurn || !payload.cwd)) {
    throw new Error('工作区准备只允许有明确目录与命令标识的新会话；不能携带旧会话或编辑边界')
  }
  return {
    prompt: payload.prompt,
    ...(payload.workspace === undefined ? {} : { workspace: parseWorkspaceStartSelection(payload.workspace) }),
    ...(commandId ? { commandId } : {}),
    ...(networkLabel ? { networkLabel } : {}),
    ...(typeof payload.cwd === 'string' && payload.cwd.trim() ? { cwd: payload.cwd } : {}),
    ...(payload.expectedExternalSessionId === null
      ? { expectedExternalSessionId: null }
      : typeof payload.expectedExternalSessionId === 'string' && payload.expectedExternalSessionId
        ? { expectedExternalSessionId: payload.expectedExternalSessionId }
        : {}),
    ...(replaceRunId && replaceProviderTurnId && replaceForkTurnId ? {
      forkLastTurn: {
        replaceRunId,
        replaceProviderTurnId,
        replaceForkTurnId,
        ...(previousProviderTurnId ? { previousProviderTurnId } : {}),
        ...(previousForkTurnId ? { previousForkTurnId } : {})
      }
    } : {}),
    ...(restartReplaceRunId ? { restartLastTurn: { replaceRunId: restartReplaceRunId } } : {}),
    providerId,
    agentId,
    ...(agentProfileId ? { agentProfileId } : {}),
    backend: payload.backend ?? 'local',
    runtimeProvider: payload.runtimeProvider ?? expectedRuntime,
    attachments: normalizeAgentAttachments(payload.attachments),
    ...(modelId ? { model: { id: modelId, ...(modelProviderId ? { providerId: modelProviderId } : {}) } } : {}),
    ...(effort ? { effort } : {}),
    permissionMode
  }
}

export function normalizeAgentForkSessionRequest(payload: unknown): AgentForkSessionRequest {
  if (!payload || typeof payload !== 'object') throw new Error('创建分支请求格式无效')
  const value = payload as Partial<AgentForkSessionRequest>
  const providerId = boundedControlValue(value.providerId)
  const agentProfileId = boundedControlValue(value.agentProfileId)
  const sourceSessionId = boundedControlValue(value.sourceSessionId)
  const sourceRunId = boundedControlValue(value.sourceRunId)
  const sourceProviderTurnId = boundedControlValue(value.sourceProviderTurnId)
  const sourceForkTurnId = boundedControlValue(value.sourceForkTurnId)
  const modelId = boundedControlValue(value.model?.id)
  const modelProviderId = boundedControlValue(value.model?.providerId)
  const permissionMode = value.permissionMode ?? 'default'
  if (!providerId || !['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(providerId)) {
    throw new Error('当前 Provider 不支持从指定轮次创建分支')
  }
  if (!sourceSessionId || !sourceRunId || !sourceProviderTurnId || !sourceForkTurnId) {
    throw new Error('创建分支缺少可信会话或轮次边界')
  }
  if (!isAgentPermissionMode(permissionMode)) {
    throw new Error(`permissionMode=${String(permissionMode)} 不受支持`)
  }
  if (providerId === 'pi' && !agentProfileId) throw new Error('Pi 分支缺少 agentProfileId')
  return {
    providerId: providerId as ProviderId,
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(typeof value.cwd === 'string' && value.cwd.trim() ? { cwd: value.cwd } : {}),
    sourceSessionId,
    sourceRunId,
    sourceProviderTurnId,
    sourceForkTurnId,
    ...(modelId ? { model: { id: modelId, ...(modelProviderId ? { providerId: modelProviderId } : {}) } } : {}),
    permissionMode
  }
}
