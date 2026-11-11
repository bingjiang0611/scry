/** The wrapper Electron adds to a rejected IPC handler; the channel name is not user copy. */
const IPC_WRAPPER = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/
/** The daemon-mode gate's named absence (main/daemon-channel-gate.ts). */
const DAEMON_UNAVAILABLE = /^daemon_capability_unavailable:(.+)$/
/** The background service could not be started or reached (daemon-supervisor, transport). */
const DAEMON_DOWN = /^daemon_unavailable:(\w+)$/
const DAEMON_DOWN_COPY: Readonly<Record<string, string>> = {
  daemon_userdata_owned: '后台服务无法启动：这个数据目录正被另一个 Scry 进程使用'
}

/**
 * One readable line for a failed IPC call. Daemon mode refuses a channel it has not
 * migrated with a named absence; it is shown as "not provided yet", never folded into
 * an empty list or blamed on a local file.
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(IPC_WRAPPER, '').trim()
  const absent = DAEMON_UNAVAILABLE.exec(message)
  if (absent) return `后台服务尚未提供这项功能（${absent[1]}）`
  const down = DAEMON_DOWN.exec(message)
  if (down) return `${DAEMON_DOWN_COPY[down[1]!] ?? '后台服务无法启动'}（${down[1]}）`
  if (message === 'daemon_not_running') return '后台服务未在运行，请稍后重试（daemon_not_running）'
  return message || '未知错误'
}
