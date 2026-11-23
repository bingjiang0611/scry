import { homedir } from 'node:os'
import type { ProviderId } from '../shared/provider'
import type { AgentPermissionMode, AgentStartRequest } from '../shared/runtime'
import { buildMcpExecutionSnapshot } from '../main/mcp-execution-trust'
import type { createRunPipeline } from '../host-runtime/create-run-pipeline'
import type { DaemonOrchestrationAuthority } from './orchestration-authority'
import { DaemonDelegationRuntime } from './delegation-runtime'

export interface HostDelegationWiringDeps {
  authority: DaemonOrchestrationAuthority
  pipeline: ReturnType<typeof createRunPipeline>
  requestRunStop: (runId: string) => boolean
  onTaskChanged: () => void
  log: (line: string) => void
}

/**
 * Wires `DaemonDelegationRuntime` into the daemon host process so `host-process.ts` stays concise.
 */
export function createHostDelegationRuntime(deps: HostDelegationWiringDeps): DaemonDelegationRuntime {
  return new DaemonDelegationRuntime({
    sink: deps.authority.sink,
    currentTrustFingerprint: (provider, cwd) => {
      try {
        const snapshot = buildMcpExecutionSnapshot({ providerId: provider as ProviderId, cwd, homeDir: homedir() })
        return snapshot?.fingerprint ?? 'empty'
      } catch {
        return 'unreadable'
      }
    },
    // SubscribeHub tracks whether the local App is actively subscribed (idleMs() === 0 while a read is active).
    hasLocalSubscriber: () => deps.authority.subscribeHub.idleMs() < 30_000,
    requestRunStop: deps.requestRunStop,
    dispatchChildRun: async (input) => {
      const permissionMode = input.task.permissionMode as AgentPermissionMode
      const req: AgentStartRequest = {
        providerId: input.task.provider as ProviderId,
        prompt: input.prompt,
        cwd: input.task.cwd,
        permissionMode,
        ...(input.task.profile ? { agentProfileId: input.task.profile } : {}),
        ...(input.task.targetModel ? { model: { id: input.task.targetModel } } : {}),
        ...(input.task.targetEffort ? { effort: input.task.targetEffort } : {})
      }
      const completion = await deps.pipeline.startAppRun(req, {
        runId: input.childRunId,
        ledgerRunId: input.childRunId,
        origin: 'remote',
        permissionModeOverride: permissionMode
      })
      if ('status' in completion && typeof completion.status === 'string') {
        const mapped =
          completion.status === 'completed'
            ? 'completed'
            : completion.status === 'cancelled'
              ? 'cancelled'
              : completion.status === 'interrupted'
                ? 'interrupted'
                : 'failed'
        const finalText = 'finalMessage' in completion && typeof completion.finalMessage === 'string'
          ? completion.finalMessage
          : undefined
        return {
          status: mapped,
          ...(finalText
            ? {
                finalMessage: {
                  status: 'available' as const,
                  quality: 'exact' as const,
                  source: ['provider-run-completion'],
                  value: finalText
                }
              }
            : {})
        }
      }
      return { status: 'completed' }
    },
    onTaskChanged: deps.onTaskChanged,
    log: deps.log
  })
}
