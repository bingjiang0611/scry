import type { RendererRestartRecord } from '../../shared/renderer-restart'

// 崩溃重载是主进程单方面做的决定，renderer 无从得知。这里保存最近一次自动重启的证据，
// 并只交付一次：读者是重载后的新 renderer，旧记录不能留到下一次正常启动继续报警。
export interface RendererRestartLog {
  record: (reason: string, exitCode: number) => void
  take: () => RendererRestartRecord | null
}

export function createRendererRestartLog(now: () => Date = () => new Date()): RendererRestartLog {
  let pending: RendererRestartRecord | null = null
  return {
    record: (reason, exitCode) => {
      pending = { reason, exitCode, at: now().toISOString() }
    },
    take: () => {
      const record = pending
      pending = null
      return record
    }
  }
}
