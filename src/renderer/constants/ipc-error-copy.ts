/** The wrapper Electron adds to a rejected IPC handler; the channel name is not user copy. */
const IPC_WRAPPER = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/
/** The daemon-mode gate's named absence (main/daemon-channel-gate.ts). */
const DAEMON_UNAVAILABLE = /^daemon_capability_unavailable:(.+)$/

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
  return message || '未知错误'
}
