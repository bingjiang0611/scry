// 派生 Claude Code 子进程后的信号处理：先按身份验证进程树，再退回自己的 handle。
// 抽成模块，一是让 agent-runner 保持在单文件预算内，二是让这段判定能单独读。

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { signalProcessTreeWithIdentity, type ProcessIdentity } from './process-diagnostics'

export function signalSpawnedChild(
  child: ChildProcessWithoutNullStreams,
  identityPromise: Promise<ProcessIdentity | undefined>,
  signal: NodeJS.Signals
): void {
  void (async () => {
      let identity: ProcessIdentity | undefined
      try { identity = await identityPromise } catch { /* identity unknown: handle fallback below */ }
      if (child.exitCode !== null || child.signalCode !== null) return
      // Only process-group/tree signals need identity: other PIDs in the group are not protected by Node's handle.
      let outcome: ReturnType<typeof signalProcessTreeWithIdentity> | undefined
      if (identity?.startedAt && process.platform !== 'win32') {
        try { outcome = signalProcessTreeWithIdentity({ identity, signal }) } catch { /* fall back to the handle */ }
      }
      if (outcome?.status === 'signalled') return
      // Node has not reaped this child before 'exit', so its PID cannot have been reused;
      // signalling our own handle is safe even when identity is unknown or tree verification failed.
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal) } catch { /* already gone */ }
      }
    })()
}
