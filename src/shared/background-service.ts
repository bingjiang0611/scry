import type { ProviderId } from './provider'
import type { AgentPermissionMode } from './runtime-types'
import type { CliApprovalStatus, HostCliApprovalSelfReport } from './host-admin'


export type BackgroundServiceLaunchedBy = 'app' | 'service'

export type BackgroundServiceRelayMode = 'public' | 'custom_ws' | 'custom_tcp' | 'disabled'

export interface BackgroundServiceRemoteConfig {
  remoteHostEnabled: boolean
  relayMode: BackgroundServiceRelayMode
  permissionModeOverride: AgentPermissionMode | null
  disabledProviders: ProviderId[]
  runControlsEnabled: boolean
  providerManifestUrl: string | null
}

export type BackgroundServiceConfigField = keyof BackgroundServiceRemoteConfig

export interface LoginStartPolicyEntry {
  key: string
  value: string
}

export type LoginStartStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled'; loaded?: boolean; linuxLinger?: 'yes' | 'no' | 'unknown' }
  | {
    state: 'enabled'
    loaded: boolean
    policyEnv: LoginStartPolicyEntry[]
    rewrittenFromExecutable?: string
    linuxLinger?: 'yes' | 'no' | 'unknown'
    linuxMainPid?: number | null
  }
  | {
    state: 'conflict'
    reason: 'login_start_other_userdata' | 'login_start_other_app' | 'login_start_foreign_service'
    otherUserDataDir?: string
    otherExecutable?: string
  }

export interface BackgroundServiceRuntimeNotice {
  serviceLaunchFallback?: { reason: string; exitCode?: number }
  remoteConfigMismatch?: {
    diffs: BackgroundServiceConfigField[]
    expected: BackgroundServiceRemoteConfig
    actual: BackgroundServiceRemoteConfig
  }
}

export type BackgroundServiceConnection =
  | { state: 'ready' }
  | { state: 'version-mismatch'; running: string | null; expected: string }
  | { state: 'device-not-authorized' }
  | { state: 'unavailable'; reason: string }

export type BackgroundServiceDevices =
  | { state: 'remote-disabled' }
  | { state: 'known'; paired: number }

export interface BackgroundServiceOrchestrationStatus {
  mode: 'on'
  writeIndeterminate?: boolean
}

export interface BackgroundServiceSelfReport {
  version: string
  pid: number
  startedAt: number
  devices: BackgroundServiceDevices
  activeRuns: number
  launchedBy?: BackgroundServiceLaunchedBy
  supervisorPid?: number
  remoteConfig?: BackgroundServiceRemoteConfig
  cliApproval?: HostCliApprovalSelfReport
  orchestration?: BackgroundServiceOrchestrationStatus
}

export type BackgroundServiceStatus =
  | {
    mode: 'daemon'
    userDataDir: string
    connection: BackgroundServiceConnection
    version: string | null
    pid: number | null
    startedAt: number | null
    devices: BackgroundServiceDevices | null
    activeRuns: number | null
    launchedBy?: BackgroundServiceLaunchedBy | null
    launchedByVerified?: boolean
    remoteConfig?: BackgroundServiceRemoteConfig | null
    loginStart?: LoginStartStatus
    cliApproval?: CliApprovalStatus
    orchestration?: BackgroundServiceOrchestrationStatus
    runtimeNotice?: BackgroundServiceRuntimeNotice
    checkedAt: number
  }

export type BackgroundServiceAction = 'restart' | 'quit' | 'reconnect'

export type BackgroundServiceActionResult =
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string; message: string }

const DAEMON_CREDENTIAL_UNAVAILABLE = 'daemon_credential_unavailable'

export function isDaemonCredentialUnavailable(reason: string): boolean {
  return reason === DAEMON_CREDENTIAL_UNAVAILABLE || reason.startsWith(`${DAEMON_CREDENTIAL_UNAVAILABLE}:`)
}

export function daemonCredentialUnavailableMessage(reason: string, linux: boolean): string {
  const base = `系统密钥环不可用，Scry 无法保存本机后台服务的连接凭据，因此不能连接后台服务（${reason}）。`
  if (!linux) return base
  return `${base}Linux 上需要一个正在运行且已解锁的 Secret Service 密钥环（例如 gnome-keyring），然后重启 Scry。`
}
