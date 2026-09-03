import type { AgentStopState } from '@shared/runtime'

export interface RunStopStatus {
  tone: 'running' | 'stopping' | 'unsettled'
  label: string
  hint: string
  /** Provider 已确认终止之前，这一轮不能显示成完成。 */
  providerSettled: boolean
}

const RUNNING: RunStopStatus = {
  tone: 'running',
  label: '运行中',
  hint: '可继续输入，新消息将加入队列',
  providerSettled: false
}

/**
 * 把 main 的停止阶段翻译成不夸大的 UI 文案：请求过停止不等于已经停下，
 * forceKill 也只是「已发出」；只有 Provider settle 才有终止证据。
 */
export function runStopStatus(state: AgentStopState | undefined): RunStopStatus {
  if (!state) return RUNNING
  switch (state.phase) {
    case 'interrupt_requested':
      return {
        tone: 'stopping',
        label: '停止中',
        hint: `已请求 ${state.providerId} 取消当前轮次，等待 Provider 收口`,
        providerSettled: false
      }
    case 'force_kill_requested':
      return {
        tone: 'stopping',
        label: '强制终止中',
        hint: `${state.providerId} 未在 ${Math.round(state.window.gracefulMs / 1000)}s 内响应取消，已发出强制终止`,
        providerSettled: false
      }
    case 'no_safe_force_kill': {
      const failed = state.forceKillBlockReason === 'force_kill_failed'
      const reason = state.forceKillBlockReason === 'shared_transport'
        ? '它的运行通道由多个并发轮次共用，强制终止会连带杀掉无关轮次'
        : failed
          ? '强制终止调用失败，不能声称已经终止 Provider'
          : 'Provider 运行句柄或硬杀范围尚不可确认，无法安全发出强制终止'
      const outcome = failed ? 'Scry 无法确认强制终止已生效' : 'Scry 没有发出强制终止'
      return {
        tone: 'unsettled',
        label: 'Provider 未确认终止',
        hint: `${state.providerId} 未在 ${Math.round(state.window.gracefulMs / 1000)}s 内响应取消；${reason}，因此${outcome}。该轮次可能还在后台运行，用量与文件足迹尚未收敛。新消息会先进队列，等这一轮真正收口后再发送`,
        providerSettled: false
      }
    }
    case 'provider_unsettled':
      return {
        tone: 'unsettled',
        label: 'Provider 未确认终止',
        hint: `强制终止已发出，但 ${state.providerId} 仍未上报终态；该轮次可能还在后台运行，用量与文件足迹尚未收敛。新消息会先进队列，等这一轮真正收口后再发送`,
        providerSettled: false
      }
    case 'settled':
      return { ...RUNNING, providerSettled: true }
  }
}
