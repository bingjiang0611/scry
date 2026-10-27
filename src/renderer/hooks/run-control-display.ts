import type { CapabilityEnvelope, ProviderContext, ProviderId } from '@shared/provider'
import type { AgentRunControlCatalog, AgentRunControls } from '@shared/runtime'
import { contextKey, fallbackRunControlCatalog, resolveRunControlSelection } from './integration-model'

// 运行控制目录只描述模型、推理强度与权限，不含项目级 Skill/命令。Pi 的这些选项来自
// Pi 自身配置（get_available_models / get_available_thinking_levels / 静态权限），
// 与 cwd 无关；其他 Provider 可能按目录返回模型（例如 OpenCode 按 directory 请求），
// 所以只在已证明与 cwd 无关的 Provider 上跨目录复用，新 Provider 需先给出证据。
const cwdIndependentRunControlCatalog: ReadonlySet<ProviderId> = new Set<ProviderId>(['pi'])

/**
 * 同一 Provider+Profile 的最后已知运行控制目录。切换会话时 cwd 往往变化，精确上下文
 * 缓存会 miss；这里给出仍可精确证明的选项，并标注来源与正在复核，避免发送界面退回
 * 占位权限、等 Provider 冷启动探测（Pi 约 2 秒）后才可用。
 */
export function lastKnownRunControlCatalog(
  catalogs: ReadonlyMap<string, CapabilityEnvelope<AgentRunControlCatalog>>,
  context: ProviderContext
): CapabilityEnvelope<AgentRunControlCatalog> | undefined {
  if (!cwdIndependentRunControlCatalog.has(context.providerId)) return undefined
  let newest: CapabilityEnvelope<AgentRunControlCatalog> | undefined
  for (const envelope of catalogs.values()) {
    if (envelope.providerId !== context.providerId) continue
    if ((envelope.agentProfileId ?? '') !== (context.agentProfileId ?? '')) continue
    if (!envelope.data || envelope.data.models.length === 0 || envelope.data.permissions.length === 0) continue
    if (!newest || (envelope.observedAt ?? 0) > (newest.observedAt ?? 0)) newest = envelope
  }
  if (!newest) return undefined
  return {
    ...newest,
    state: 'unknown',
    reason: `最后已知模型目录（${new Date(newest.observedAt ?? Date.now()).toLocaleString()} 读取）；正在向 Provider 复核运行权限`
  }
}

export interface RunControlDisplay {
  capability: CapabilityEnvelope<AgentRunControlCatalog> | null
  catalog: AgentRunControlCatalog
  controls: AgentRunControls
  loading: boolean
  /** 结果来自精确上下文目录时才能回写用户偏好；跨目录的最后已知目录不能覆盖它。 */
  persistSelection: boolean
}

/** 当前上下文应显示的运行控制。精确上下文缓存优先，其次是可证明与 cwd 无关的
 * 最后已知目录，最后才是占位目录（此时仍 fail closed，不允许发送）。 */
export function resolveRunControlDisplay(
  catalogs: ReadonlyMap<string, CapabilityEnvelope<AgentRunControlCatalog>>,
  context: ProviderContext,
  stored: AgentRunControls
): RunControlDisplay {
  const cached = catalogs.get(contextKey(context))
  const known = cached?.data ? cached : lastKnownRunControlCatalog(catalogs, context)
  if (known?.data) {
    return {
      capability: known,
      catalog: known.data,
      controls: resolveRunControlSelection(known.data, stored),
      loading: false,
      persistSelection: known === cached
    }
  }
  const catalog = fallbackRunControlCatalog('default')
  return {
    capability: null,
    catalog,
    controls: resolveRunControlSelection(catalog, stored),
    loading: true,
    persistSelection: false
  }
}
