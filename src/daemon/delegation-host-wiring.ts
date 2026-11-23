import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative } from 'node:path'
import type { ProviderId } from '../shared/provider'
import type { AgentPermissionMode, AgentStartRequest } from '../shared/runtime'
import { buildMcpExecutionSnapshot } from '../main/mcp-execution-trust'
import { canonicalJson } from '../host-runtime/orchestration/canonical-json'
import type { createRunPipeline } from '../host-runtime/create-run-pipeline'
import type { DaemonOrchestrationAuthority } from './orchestration-authority'
import type { RunHost } from '../main/bootstrap/run-host'
import { DaemonDelegationRuntime } from './delegation-runtime'
import { createDelegatedWorktreePreparer } from './delegation-worktree'

/**
 * B1: Computes a cwd-path-independent content fingerprint from `buildMcpExecutionSnapshot`
 * so a delegated worktree with identical MCP configs & executables matches the source cwd baseline.
 */
export function computePortableMcpTrustFingerprint(provider: ProviderId, cwd: string, homeDir = homedir()): string {
  const snapshot = buildMcpExecutionSnapshot({ providerId: provider, cwd, homeDir })
  if (!snapshot) return 'empty'
  let canonicalCwd = cwd
  try { canonicalCwd = realpathSync(cwd) } catch { /* keep cwd */ }
  const normalizedTargets = snapshot.targets.map((t) => {
    const relSource = t.sourcePath ? relative(canonicalCwd, t.sourcePath) : ''
    const portableSource = relSource && !relSource.startsWith('..') ? `cwd:${relSource}` : (t.sourcePath ?? '')
    return {
      name: t.name,
      enabled: t.enabled,
      portableSource,
      config: t.config,
      executableDigest: t.executableDigest ?? null,
      executableIdentity: t.executableIdentity ?? null
    }
  }).sort((a, b) => `${a.portableSource}:${a.name}`.localeCompare(`${b.portableSource}:${b.name}`))
  return createHash('sha256').update(canonicalJson({ provider, targets: normalizedTargets })).digest('hex')
}

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
  userDataDir: string
  authorizeDirectory: (dir: string) => string
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
      // B1 & B6: fail closed on read error and normalize cwd prefixes for worktree content matching.
      return computePortableMcpTrustFingerprint(provider as ProviderId, cwd)
    },
    // B2 / P6 security §S7: require an active local App subscribe reader, not the 30s terminal idle window.
    hasLocalSubscriber: () => deps.authority.subscribeHub.hasActiveLocalSubscriber(),
    requestRunStop: deps.requestRunStop,
    prepareChildWorktree: createDelegatedWorktreePreparer({
      userDataDir: deps.userDataDir,
      authorizeDirectory: deps.authorizeDirectory
    }),
    dispatchChildRun: async (input) => {
      const permissionMode = input.task.permissionMode as AgentPermissionMode
      const isWorktree = input.task.isolation === 'worktree' && input.executionCwd !== input.task.cwd
      const req: AgentStartRequest = {
        providerId: input.task.provider as ProviderId,
        prompt: input.prompt,
        cwd: input.executionCwd,
        permissionMode,
        ...(input.task.profile ? { agentProfileId: input.task.profile } : {}),
        ...(input.task.targetModel ? { model: { id: input.task.targetModel } } : {}),
        ...(input.task.targetEffort ? { effort: input.task.targetEffort } : {})
      }
      // B2 & B5: pass grantScope='local' and workspaceAdmission for isolated worktrees so frontdoor authorizes them.
      const completion = await deps.pipeline.startAppRun(req, {
        runId: input.childRunId,
        ledgerRunId: input.childRunId,
        origin: 'remote',
        grantScope: 'local',
        permissionModeOverride: permissionMode,
        ...(isWorktree
          ? {
              projectCwd: input.task.cwd,
              workspaceAdmission: {
                cwd: input.executionCwd,
                admit: async (register) => { register() }
              }
            }
          : {})
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
