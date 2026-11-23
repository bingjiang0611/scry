import { homedir } from 'node:os'
import type { ProviderId } from '../shared/provider'
import type { AgentPermissionMode, AgentStartRequest } from '../shared/runtime'
import { buildMcpExecutionSnapshot } from '../main/mcp-execution-trust'
import type { createRunPipeline } from '../host-runtime/create-run-pipeline'
import type { DaemonOrchestrationAuthority } from './orchestration-authority'
import type { RunHost } from '../main/bootstrap/run-host'
import { DaemonDelegationRuntime } from './delegation-runtime'

export function prepareHostRunOrchestration(
  getRuntime: () => DaemonDelegationRuntime | undefined
): NonNullable<RunHost['prepareOrchestrationTools']> {
  return (run) => {
    const rt = getRuntime()
    if (!rt) return Promise.resolve({ cleanup: () => undefined })
    return rt.prepareRunOrchestration({
      runId: run.runId,
      canonicalRunId: run.ledgerRunId ?? run.runId,
      providerId: run.providerId,
      profile: run.agentProfileId,
      cwd: run.cwd,
      sessionKey: run.sessionKey,
      permissionMode: run.permissionMode,
      via: run.isRemoteRun && run.grantScope !== 'local' ? 'remote' : 'local'
    })
  }
}

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
      // Fail closed (B6 / P6 security §S3): never substitute a constant on read failure.
      const snapshot = buildMcpExecutionSnapshot({ providerId: provider as ProviderId, cwd, homeDir: homedir() })
      return snapshot?.fingerprint ?? 'empty'
    },
    // B2 / P6 security §S7: require an active local App subscribe reader, not the 30s terminal idle window.
    hasLocalSubscriber: () => deps.authority.subscribeHub.hasActiveLocalSubscriber(),
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
      // B5: pass grantScope='local' so local workspace authorization applies (not remoteProjectRoots).
      const completion = await deps.pipeline.startAppRun(req, {
        runId: input.childRunId,
        ledgerRunId: input.childRunId,
        origin: 'remote',
        grantScope: 'local',
        permissionModeOverride: permissionMode
      })
      if ('status' in completion && typeof completion.status === 'string') {
        const rawStatus: string = completion.status
        const mapped =
          rawStatus === 'completed'
            ? 'completed'
            : rawStatus === 'cancelled'
              ? 'cancelled'
              : rawStatus === 'interrupted'
                ? 'interrupted'
                : rawStatus === 'unavailable'
                  ? 'unavailable'
                  : 'failed'
        const reason = 'error' in completion && typeof completion.error === 'string'
          ? completion.error
          : undefined
        // B5 / P6 evidence §E1: never fabricate quality='exact'; leave finalMessage null when archive reader is absent.
        return {
          status: mapped,
          ...(reason ? { reason } : {})
        }
      }
      return { status: 'completed' }
    },
    onTaskChanged: deps.onTaskChanged,
    log: deps.log
  })
}
