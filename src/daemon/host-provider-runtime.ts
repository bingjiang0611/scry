import { createProviderRuntime } from '../main/bootstrap/provider-runtime'
import { createPiProfileRuntime } from '../main/bootstrap/pi-profiles'
import type { PiAgentProfile } from '../main/pi-agent-profiles'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { createProviderSessionObservers } from './provider-session-recording'

/**
 * C1: the daemon owns Provider session lifetime, because only the daemon can store why a session was
 * released. This builds the adapter runtime together with the observers that record it.
 */
export function createDaemonProviderRuntime(options: {
  userDataDir: string
  homeDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
  authority: () => EventSink | undefined
  listPiProfiles: () => Promise<PiAgentProfile[]>
  resolvePiProfile: (id: string) => Promise<PiAgentProfile | undefined>
}) {
  const { providerSessions, piSessions, codexSessions, openCodeSessions, qoderSessions } =
    createProviderSessionObservers(options.authority)
  return createProviderRuntime({
    providerSessions,
    piSessions,
    codexSessions,
    openCodeSessions,
    qoderSessions,
    homeDir: options.homeDir,
    userDataDir: options.userDataDir,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged,
    listPiProfiles: options.listPiProfiles,
    resolvePiProfile: options.resolvePiProfile
  })
}

export { createPiProfileRuntime }
