import { daemonCredentialUnavailableMessage, isDaemonCredentialUnavailable, type BackgroundServiceAction } from '../shared/background-service'
import { BACKGROUND_SERVICE_STOP_TIMEOUT_MS } from './background-service-stop'

// Words for the «后台服务» confirmations and failures. background-service-actions.ts
// decides; this only names the decision, free of Electron, so the consequence a dialog
// states is checked next to the rule that shows it.

export const CONFIRM_BUTTON = 0
export const CANCEL_BUTTON = 1

export interface BackgroundServicePrompt {
  type: 'warning' | 'info'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

const INTERRUPTED = '正在运行的任务会被中断，并记为失败（failed(host_restarted)）：Provider 可能已部分执行，需要你核对后再决定是否重发。'
const DEVICES = '已配对设备的连接也会断开，后台服务重新启动后才能再连上。'

function runsLine(activeRuns: number | null): string {
  if (activeRuns === null) return `无法确认后台服务里是否有正在运行的任务。如果有，${INTERRUPTED}`
  return `后台服务里有 ${activeRuns} 个正在运行的任务。${INTERRUPTED}`
}

/** The second confirmation; `activeRuns` null means the App could not ask the daemon. */
export function confirmPrompt(action: BackgroundServiceAction, activeRuns: number | null): BackgroundServicePrompt {
  const base = { type: 'warning' as const, defaultId: CANCEL_BUTTON, cancelId: CANCEL_BUTTON }
  if (action === 'restart') {
    return {
      ...base,
      title: '重启后台服务',
      message: '重启后台服务会中断正在运行的任务',
      detail: [runsLine(activeRuns), DEVICES, '确认后，Scry 只向 daemon.lock 记录且身份复核一致的后台服务进程发送一次停止信号，再启动与本 App 版本一致的后台服务并重新连接。'].join('\n\n'),
      buttons: ['重启后台服务', '取消']
    }
  }
  if (action === 'quit') {
    return {
      ...base,
      title: '退出 Scry 与后台服务',
      message: '退出后台服务会中断正在运行的任务',
      detail: [runsLine(activeRuns), DEVICES, '后台服务退出后 Scry 也会退出。普通的退出 Scry 不会停止后台服务。'].join('\n\n'),
      buttons: ['退出 Scry 与后台服务', '取消']
    }
  }
  return {
    ...base,
    title: '重新连接本机后台服务',
    message: '本机 App 与后台服务的连接已被撤销',
    detail: [
      '重新连接会先停止后台服务，再让它生成新的一次性入网凭据，由本 App 重新入网。',
      runsLine(activeRuns),
      DEVICES,
      '如果连接是被另一个 Scry 实例接管的，那个实例会断开。Scry 不会自动重新连接，只在你确认后执行。'
    ].join('\n\n'),
    buttons: ['重新连接', '取消']
  }
}

const REASONS: Readonly<Record<string, string>> = {
  daemon_mode_disabled: '后台服务模式未启用（SCRY_HOST_DAEMON），Agent 运行在 App 进程内，没有后台服务可操作。',
  'lock-unreadable': '无法读取 daemon.lock，不能确认后台服务是哪个进程；没有发送任何信号。',
  'identity-unrecorded': 'daemon.lock 没有记录进程身份，不能安全地停止它；没有发送任何信号。',
  'identity-unreadable': '无法读取 daemon.lock 记录的进程身份，不能确认它就是后台服务；没有发送任何信号。',
  'identity-changed': 'daemon.lock 记录的进程号已属于另一个进程（可能被复用），没有发送任何信号。',
  'lock-changed': '确认之后后台服务换了进程，没有向新进程发送信号。请刷新后重试。',
  'signal-failed': '无法向后台服务进程发送停止信号（权限不足或进程状态异常）。',
  'stop-timeout': `已向后台服务发送一次停止信号，但它在 ${Math.round(BACKGROUND_SERVICE_STOP_TIMEOUT_MS / 1000)} 秒内没有退出。Scry 没有再次发送信号，也没有强制结束；请稍后刷新查看，或手动检查该进程。`,
  daemon_device_authorized: '本机连接没有被撤销，不需要重新连接。',
  daemon_version_mismatch: '重新启动后连接到的后台服务版本仍与本 App 不一致（可能有另一个监护进程又拉起了旧版本）。',
  daemon_device_not_authorized: '后台服务拒绝了本 App 的连接（本机连接已被撤销、已在另一实例入网，或本 App 保存的连接凭据已丢失）。',
  daemon_stopping: '后台服务正在停止，暂不启动新的后台服务。',
  daemon_ready_timeout: '后台服务在限定时间内没有就绪。',
  action_in_progress: '另一个后台服务操作正在进行，请等它结束。'
}

/** One readable sentence for a machine reason; unknown reasons keep their code visible. */
export function reasonMessage(reason: string, platform: NodeJS.Platform = process.platform): string {
  const known = REASONS[reason]
  if (known) return known
  if (isDaemonCredentialUnavailable(reason)) return daemonCredentialUnavailableMessage(reason, platform === 'linux')
  return `后台服务操作没有完成（${reason}）。`
}

/** Shown before quitting when the stopped daemon left something behind. */
export function leftoverNotice(leftovers: readonly string[]): BackgroundServicePrompt {
  return {
    type: 'warning',
    title: '后台服务已退出，但有残留',
    message: '后台服务进程已退出，以下内容仍然存在',
    detail: [
      leftovers.map((item) => `• ${item}`).join('\n'),
      '下次启动时后台服务会按身份规则接管失效的锁与 socket；监护进程残留时请手动检查。Scry 现在退出。'
    ].join('\n\n'),
    buttons: ['退出'],
    defaultId: 0,
    cancelId: 0
  }
}

export const MISMATCH_RESTART_BUTTON = 0
export const MISMATCH_LATER_BUTTON = 1

/**
 * Shown once per App process when the daemon turns out to be another version (approved
 * 2026-11-12). `running` is null when the daemon refused before saying its version: the
 * prompt says so instead of naming one.
 */
export function versionMismatchPrompt(running: string | null, expected: string): BackgroundServicePrompt {
  const versions = running
    ? `正在运行的后台服务版本是 ${running}，本 App 的版本是 ${expected}。`
    : `正在运行的后台服务版本未知（它没有报告自己的版本），与本 App 的版本 ${expected} 不一致。`
  return {
    type: 'warning',
    title: '后台服务版本不一致',
    message: '正在运行的后台服务来自另一个版本的 Scry',
    detail: [
      versions,
      '运行任务和终端需要与本 App 版本一致的后台服务。重启后台服务会停止旧版本，再启动与本 App 一致的版本；如果后台服务里可能有正在运行的任务，Scry 会先请你确认。',
      '选择「稍后」不做任何操作，本次运行期间不会再提示；之后可以在「设置 → 后台服务」中重启。'
    ].join('\n\n'),
    buttons: ['重启后台服务', '稍后'],
    defaultId: MISMATCH_RESTART_BUTTON,
    cancelId: MISMATCH_LATER_BUTTON
  }
}

/** A restart started from the startup prompt did not finish; `message` is reasonMessage(). */
export function restartFailedNotice(message: string): BackgroundServicePrompt {
  return {
    type: 'warning',
    title: '重启后台服务没有完成',
    message: '后台服务没有重启',
    detail: [message, 'Scry 不会自动重试。可以在「设置 → 后台服务」中查看状态后再试。'].join('\n\n'),
    buttons: ['好'],
    defaultId: 0,
    cancelId: 0
  }
}
