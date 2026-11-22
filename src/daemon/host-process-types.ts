import type { ProviderOperationGate } from '../main/provider-operation-gate'
import type { RemoteHostService, RemoteHostServiceDependencies } from '../main/remote/remote-host-service'
import type { LocalChannel } from './local-channel'
import type { LocalEnrollSocket } from './local-enrollment'
import type { DaemonOrchestrationAuthority } from './orchestration-authority'
import type { DaemonOrchestrationShadow } from './orchestration-shadow'
import type { DaemonTerminalServiceDeps } from './terminal-service'
import type { HostAdminStore } from './host-admin-store'
import type { HostAdminSocket } from './host-admin-socket'

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
  terminal?: Pick<DaemonTerminalServiceDeps, 'pty' | 'inlineRecording' | 'environment' | 'reclaimAfterMs' | 'checkEveryMs'>
  orchestrationShadowBeforeCommitHook?: () => void
  orchestrationMirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  orchestrationMirrorMaxPendingEvents?: number
  orchestrationMirrorRetryIntervalMs?: number
  orchestrationShadowPauseBackfill?: Promise<void>
  providerDisposeTimeoutMs?: number
  executionTargetCallTimeoutMs?: number
}

export interface DaemonHostProcess {
  service: RemoteHostService
  channel: LocalChannel
  enrollSocket: LocalEnrollSocket
  adminSocket?: HostAdminSocket
  hostAdmin: HostAdminStore
  providerOperationGate: ProviderOperationGate
  orchestrationShadow?: DaemonOrchestrationShadow
  orchestrationAuthority?: DaemonOrchestrationAuthority
  dispose(): Promise<void>
}
