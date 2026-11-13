import { llmPerformanceChannelHandlers, providerCommandChannelHandlers, recorderContentChannelHandlers, skillChannelHandlers, usageChannelHandlers, workspaceDiffChannelHandlers } from '../../main/bootstrap/query-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

// Read-only queries: usage, LLM performance, git diff, recorder content, skills, commands.
// The same handler tables main registers, built over this process's userData, run
// registry, project authority and Provider registry: in daemon mode those are the ones
// that hold the data.
export const queryLocalOps: DaemonLocalOpGroup = ({ workspace, providers, session, runs, userDataDir }) => ({
  ...usageChannelHandlers({ userDataDir: () => userDataDir }),
  ...llmPerformanceChannelHandlers({ userDataDir: () => userDataDir, activeRuns: () => runs().activeStates() }),
  ...workspaceDiffChannelHandlers(workspace.resolveKnownProjectDirectory),
  ...recorderContentChannelHandlers({
    userDataDir: () => userDataDir,
    workspace: (appended) => appendedWorkspace(appended, workspace.resolveKnownProjectDirectory),
    // The App holds the selection and checks it again once the reply is back.
    stillCurrent: () => true
  }),
  ...skillChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation }),
  ...providerCommandChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation })
} as Record<string, LocalOpHandler>)

/**
 * The workspace the App appended to a recorder content request (its window's selection).
 * Only the local endpoint serves this op, and the daemon still trusts nothing it did not
 * check: a directory its own project authority does not know, a missing argument or a
 * non-string is main's refusal for a read without a workspace. `''` is that App's
 * "no selection", which only app-trace bodies of runs without a cwd may be read for.
 */
function appendedWorkspace(appended: unknown, resolveKnownProjectDirectory: (cwd: string) => string): string {
  if (appended === '') return ''
  if (typeof appended !== 'string') throw new Error('recorder_workspace_unavailable')
  try {
    return resolveKnownProjectDirectory(appended)
  } catch {
    throw new Error('recorder_workspace_unavailable')
  }
}
