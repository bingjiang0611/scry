import { llmPerformanceChannelHandlers, providerCommandChannelHandlers, recorderContentChannelHandlers, skillChannelHandlers, usageChannelHandlers, workspaceDiffChannelHandlers } from '../../main/bootstrap/query-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

export const queryLocalOps: DaemonLocalOpGroup = ({ workspace, providers, session, runs, userDataDir }) => ({
  ...usageChannelHandlers({ userDataDir: () => userDataDir }),
  ...llmPerformanceChannelHandlers({ userDataDir: () => userDataDir, activeRuns: () => runs().activeStates() }),
  ...workspaceDiffChannelHandlers(workspace.resolveKnownProjectDirectory),
  ...recorderContentChannelHandlers({
    userDataDir: () => userDataDir,
    workspace: (appended) => appendedWorkspace(appended, workspace.resolveKnownProjectDirectory),
    stillCurrent: () => true
  }),
  ...skillChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation }),
  ...providerCommandChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation })
} as Record<string, LocalOpHandler>)

function appendedWorkspace(appended: unknown, resolveKnownProjectDirectory: (cwd: string) => string): string {
  if (appended === '') return ''
  if (typeof appended !== 'string') throw new Error('recorder_workspace_unavailable')
  try {
    return resolveKnownProjectDirectory(appended)
  } catch {
    throw new Error('recorder_workspace_unavailable')
  }
}
