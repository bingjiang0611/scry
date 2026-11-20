import type { RemoteHostService, RemoteHostServiceDependencies } from '../main/remote/remote-host-service'
import type { LocalChannel } from './local-channel'
import type { LocalEnrollSocket } from './local-enrollment'
import type { DaemonOrchestrationAuthority } from './orchestration-authority'
import type { DaemonOrchestrationShadow } from './orchestration-shadow'
import type { DaemonTerminalServiceDeps } from './terminal-service'

export interface DaemonHostProcessOptions {
  userDataDir: string
  daemonStateDirectory: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
  gatewayLabel?: string
  createOutputStore?: RemoteHostServiceDependencies['createOutputStore']
  log?: (line: string) => void
  /** Tests: a fake PTY, recordings in this process, a fixed shell environment, a short reclaim. */
  terminal?: Pick<DaemonTerminalServiceDeps, 'pty' | 'inlineRecording' | 'environment' | 'reclaimAfterMs' | 'checkEveryMs'>
  /** Tests: inject commit fault into P4-1 orchestration shadow sink. */
  orchestrationShadowBeforeCommitHook?: () => void
  /** Tests: pause deferred shadow backfill until resolved to verify live/backfill interleaving. */
  orchestrationShadowPauseBackfill?: Promise<void>
  /** Tests: override graceful providerRegistry.dispose() timeout (default 5,000 ms). */
  providerDisposeTimeoutMs?: number
}

export interface DaemonHostProcess {
  service: RemoteHostService
  channel: LocalChannel
  enrollSocket: LocalEnrollSocket
  orchestrationShadow?: DaemonOrchestrationShadow
  orchestrationAuthority?: DaemonOrchestrationAuthority
  dispose(): Promise<void>
}
