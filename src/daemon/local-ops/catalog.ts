import { catalogChannelHandlers, providerControlChannelHandlers, providerDetectionChannelHandlers, resetProviderSession } from '../../main/bootstrap/startup-channels'
import type { ProviderContext } from '../../shared/provider'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import { withoutEvent, type DaemonLocalOpGroup } from './deps'

export const catalogLocalOps: DaemonLocalOpGroup = ({ catalog, workspace, providers, pi, session, historyChannels }) => ({
  ...catalogChannelHandlers({
    appSessionStore: catalog.appSessionStore,
    listProjectCatalog: catalog.listProjectCatalog,
    recentStore: workspace.recentStore
  }),
  ...providerDetectionChannelHandlers({
    smokeProviderEnabled: providers.smokeProviderEnabled,
    smokeDetectedAgents: providers.smokeDetectedAgents,
    storedPiProfiles: pi.storedPiProfiles,
    providerCompatibility: providers.providerCompatibility,
    detectInstalledAgents: pi.detectInstalledAgents,
    providerRegistry: providers.providerRegistry
  }),
  ...providerControlChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation }),
  'agent:newSession': (context: unknown) => resetProviderSession({
    providerRegistry: providers.providerRegistry, providerContextKey: session.providerContextKey,
    resetSessionContext: session.resetSessionContext, currentCwd: () => undefined
  }, context as ProviderContext | undefined),
  ...withoutEvent(historyChannels)
} as Record<string, LocalOpHandler>)
