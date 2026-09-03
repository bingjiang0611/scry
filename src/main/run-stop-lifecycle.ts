import type { ProviderId } from '../shared/provider'
import type {
  AgentForceKillScope,
  AgentStopEscalationWindow,
  AgentStopPhase,
  AgentStopState,
  RuntimeProvider
} from '../shared/runtime'

/**
 * 每个 transport 的优雅取消窗口。Claude SDK 的 interrupt 要等当前 assistant turn 收口，
 * CLI/RPC transport 只需一次协议往返；窗口到点仍未 settle 才允许升级到 forceKill。
 * forceKillMs 是 forceKill 之后仍给 Provider 的最后收口时间，超过它只能诚实报告未确认终止。
 */
const STOP_ESCALATION_WINDOWS: Record<RuntimeProvider, AgentStopEscalationWindow> = {
  claude_sdk: { gracefulMs: 6000, forceKillMs: 4000 },
  codex_cli: { gracefulMs: 4000, forceKillMs: 4000 },
  qoder_cli: { gracefulMs: 4000, forceKillMs: 3000 },
  opencode_server: { gracefulMs: 5000, forceKillMs: 4000 },
  pi_rpc: { gracefulMs: 4000, forceKillMs: 3000 }
}

export function stopEscalationWindow(runtimeProvider: RuntimeProvider): AgentStopEscalationWindow {
  return STOP_ESCALATION_WINDOWS[runtimeProvider]
}

export interface StopLifecycleTarget {
  runId: string
  providerId: ProviderId
  agentProfileId?: string
  runtimeProvider: RuntimeProvider
  interrupt: () => void
  forceKill: () => void
  /**
   * 硬杀范围在升级那一刻读取（而不是请求时缓存）：transport 可能在停止请求之后
   * 才真正建立，只有当时的事实能证明硬杀是否仅限于本 run。
   */
  forceKillScope: () => AgentForceKillScope | undefined
}

export interface RunStopLifecycleOptions {
  publish: (state: AgentStopState) => void
  /** 注入定时器，让测试用假时钟断言有界升级而不依赖真实墙钟。 */
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
  warn?: (message: string, runId: string, error: unknown) => void
}

interface StopLifecycleEntry {
  state: AgentStopState
  cancel: (() => void) | null
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/**
 * 有界停止升级：interrupt -> (窗口到点) run-scoped forceKill -> (窗口到点) 诚实报告 provider_unsettled。
 * 硬杀作用于共享 transport、句柄范围不可确认或调用失败时不冒充成功，
 * 直接诚实报告 no_safe_force_kill，避免杀掉无关 run 或伪造控制结果。
 * 它从不在 Provider settle 之前宣布这一轮结束；UI 终态仍然由 turnDone/error 决定。
 */
export class RunStopLifecycle {
  private readonly entries = new Map<string, StopLifecycleEntry>()
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly now: () => number

  constructor(private readonly options: RunStopLifecycleOptions) {
    this.schedule = options.schedule ?? defaultSchedule
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 幂等：重复请求只重播当前阶段，不重置已经计时的升级窗口，
   * 也不会因为用户连点而跳过 Provider 的优雅取消机会。
   */
  request(target: StopLifecycleTarget): AgentStopState {
    const existing = this.entries.get(target.runId)
    if (existing) {
      this.options.publish(existing.state)
      return existing.state
    }
    const window = stopEscalationWindow(target.runtimeProvider)
    const requestedAt = new Date(this.now()).toISOString()
    const state: AgentStopState = {
      runId: target.runId,
      providerId: target.providerId,
      runtimeProvider: target.runtimeProvider,
      ...(target.agentProfileId ? { agentProfileId: target.agentProfileId } : {}),
      phase: 'interrupt_requested',
      requestedAt,
      updatedAt: requestedAt,
      providerSettled: false,
      window
    }
    const entry: StopLifecycleEntry = { state, cancel: null }
    this.entries.set(target.runId, entry)
    this.invoke(target.runId, 'interrupt', target.interrupt)
    this.options.publish(state)
    entry.cancel = this.schedule(() => this.escalate(target), window.gracefulMs)
    return state
  }

  /** Provider runtime 已 settle：终止有证据了，取消所有未触发的升级。 */
  settle(runId: string): AgentStopState | undefined {
    const entry = this.entries.get(runId)
    if (!entry) return undefined
    entry.cancel?.()
    entry.cancel = null
    this.entries.delete(runId)
    return this.advance(entry, 'settled', true)
  }

  snapshot(runId: string): AgentStopState | undefined {
    return this.entries.get(runId)?.state
  }

  close(): void {
    for (const entry of this.entries.values()) entry.cancel?.()
    this.entries.clear()
  }

  private escalate(target: StopLifecycleTarget): void {
    const entry = this.entries.get(target.runId)
    if (!entry) return
    entry.cancel = null
    // 共享 transport（Codex app-server client、OpenCode server）上的硬杀会连带终止无关 run，
    // 因此自动升级只在硬杀可证明为 run-scoped 时发出；否则诚实报告没有安全硬杀手段，
    // 绝不在 UI 上冒充 force_kill_requested。
    const scope = this.forceKillScope(target)
    if (scope !== 'run_scoped') {
      this.advance(
        entry,
        'no_safe_force_kill',
        false,
        scope === 'shared_transport' ? 'shared_transport' : 'scope_unavailable'
      )
      return
    }
    if (!this.invoke(target.runId, 'forceKill', target.forceKill)) {
      this.advance(entry, 'no_safe_force_kill', false, 'force_kill_failed')
      return
    }
    this.advance(entry, 'force_kill_requested', false)
    entry.cancel = this.schedule(() => this.reportUnsettled(target.runId), entry.state.window.forceKillMs)
  }

  /** 读不到真实范围（adapter 抛错）时 fail closed：宁可不杀，也不能误杀其他 run。 */
  private forceKillScope(target: StopLifecycleTarget): AgentForceKillScope | undefined {
    try {
      return target.forceKillScope()
    } catch (error) {
      this.options.warn?.('stop forceKillScope failed', target.runId, error)
      return undefined
    }
  }

  private reportUnsettled(runId: string): void {
    const entry = this.entries.get(runId)
    if (!entry) return
    entry.cancel = null
    this.advance(entry, 'provider_unsettled', false)
  }

  private advance(
    entry: StopLifecycleEntry,
    phase: AgentStopPhase,
    providerSettled: boolean,
    forceKillBlockReason?: AgentStopState['forceKillBlockReason']
  ): AgentStopState {
    const next: AgentStopState = {
      ...entry.state,
      phase,
      providerSettled,
      ...(forceKillBlockReason ? { forceKillBlockReason } : {}),
      updatedAt: new Date(this.now()).toISOString()
    }
    entry.state = next
    this.options.publish(next)
    return next
  }

  private invoke(runId: string, label: string, action: () => void): boolean {
    try {
      action()
      return true
    } catch (error) {
      // 控制调用失败必须被如实记录；尤其 forceKill 失败时不能继续声称已经发出硬杀。
      this.options.warn?.(`stop ${label} failed`, runId, error)
      return false
    }
  }
}
