import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { AgentForceKillScope, AgentSteerInput, AgentSteerResult, RuntimeProvider } from '../../shared/runtime'
import type { BackgroundTaskStopResult } from '../../shared/background-work'

export interface RunControl {
  runId: string
  providerId: ProviderId
  interrupt: () => void
  forceKill: () => void
  stopBackgroundTask: (taskId: string) => Promise<BackgroundTaskStopResult>
  steer: (input: AgentSteerInput) => Promise<AgentSteerResult>
  /**
   * 硬杀当下的真实作用范围，直接来自 Provider handle。handle 还没创建时返回 undefined：
   * 没有可调用对象就不能声称已经发出 run-scoped 强制终止。
   */
  forceKillScope: () => AgentForceKillScope | undefined
  cwd?: string
  resume?: string
  getExternalSessionId: () => string | undefined
  getProviderTurnId: () => string | undefined
  canonicalLifecycle: boolean
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  adoptSession: () => void
  cleanupProvisional: () => void
  finalizeTurnDiff: () => Promise<void>
  cancelTurnDiff: () => Promise<void>
  settled: Promise<void>
}
