import { llmPerformanceChannelHandlers, skillChannelHandlers, usageChannelHandlers, workspaceDiffChannelHandlers } from '../../main/bootstrap/query-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

// Read-only queries: usage, LLM performance, git diff, skills. The same handler tables
// main registers, built over this process's userData, run registry, project authority
// and Provider registry: in daemon mode those are the ones that hold the data.
export const queryLocalOps: DaemonLocalOpGroup = ({ workspace, providers, session, runs, userDataDir }) => ({
  ...usageChannelHandlers({ userDataDir: () => userDataDir }),
  ...llmPerformanceChannelHandlers({ userDataDir: () => userDataDir, activeRuns: () => runs().activeStates() }),
  ...workspaceDiffChannelHandlers(workspace.resolveKnownProjectDirectory),
  ...skillChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation })
} as Record<string, LocalOpHandler>)
