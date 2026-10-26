// 崩溃后主进程会静默重载 renderer（见 bootstrap/window.ts）。重载会清空全部 UI 状态，
// 因此主进程把最近一次自动重启的原因留给重载后的 renderer 读一次：界面必须能说明
// "刚刚重来过"，而不是把中断的一轮显示成正常继续。
export interface RendererRestartRecord {
  /** Electron render-process-gone 的 reason，例如 crashed / oom / killed。 */
  reason: string
  exitCode: number
  /** 记录时间，ISO 8601。 */
  at: string
}
