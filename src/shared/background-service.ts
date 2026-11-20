import type { ProviderId } from './provider'
import type { AgentPermissionMode } from './runtime-types'
import type { CliApprovalStatus, HostCliApprovalSelfReport } from './host-admin'

// The settings section «后台服务» (B4-S S0-1): what the App knows about its local daemon,
// and what each of the four actions did. Every field the App could not establish is
// `null` and is shown as unknown: a daemon that did not answer has no "0 devices".

/** Who started this background service: the App directly, or the OS login service (P5 §2.1). */
export type BackgroundServiceLaunchedBy = 'app' | 'service'

/** How the background service reaches remote devices, without exposing any relay token. */
export type BackgroundServiceRelayMode = 'public' | 'custom_ws' | 'custom_tcp' | 'disabled'

/** Effective non-secret remote policy the daemon (or App env) resolves (P5 §2.2). */
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

/** Runtime warnings the App carries onto both Settings and the run/send path (P5 §2.2, §2.4). */
export interface BackgroundServiceRuntimeNotice {
  /** Service manager launch failed; the App fell back to spawning the supervisor directly. */
  serviceLaunchFallback?: { reason: string; exitCode?: number }
  /** Adopted a service-launched daemon whose effective remote policy differs from App env. */
  remoteConfigMismatch?: {
    diffs: BackgroundServiceConfigField[]
    expected: BackgroundServiceRemoteConfig
    actual: BackgroundServiceRemoteConfig
  }
}

/** How this App reaches its daemon right now. */
export type BackgroundServiceConnection =
  | { state: 'ready' }
  // The daemon answers but was built from other sources; `running` is null when it
  // refused before saying which version it is. Both are labels: a version, or a version
  // with its build id when the versions are equal (shared/build-identity.ts).
  | { state: 'version-mismatch'; running: string | null; expected: string }
  // The daemon refused this App's local grant (revoked, or enrolled by another instance),
  // or has no secret for an App that lost its stored grant while the daemon's is live (A6).
  | { state: 'device-not-authorized' }
  | { state: 'unavailable'; reason: string }

/** Paired devices only: the App's own local grant is how it reaches the daemon, not a device. */
export type BackgroundServiceDevices =
  | { state: 'remote-disabled' }
  | { state: 'known'; paired: number }

/** Authoritative orchestration status exposed by daemon status endpoints (P4-2 Decision H). */
export interface BackgroundServiceOrchestrationStatus {
  mode: 'on'
  h1FallbackUnavailable: boolean
  h1FallbackReason?: string
}

/** What the daemon reports about itself (local op `localBackgroundService:status`). */
export interface BackgroundServiceSelfReport {
  version: string
  pid: number
  /** Epoch milliseconds at which the daemon process started. */
  startedAt: number
  devices: BackgroundServiceDevices
  /** Runs the daemon has not settled yet. */
  activeRuns: number
  /** Self-reported launcher; absent when started by an older App or ad-hoc script. */
  launchedBy?: BackgroundServiceLaunchedBy
  /** Self-reported supervisor pid (`SCRY_DAEMON_STARTED_BY=supervisor:<pid>`), used on Linux for MainPID checks. */
  supervisorPid?: number
  /** Effective non-secret remote policy running in the daemon (P5 §2.2). */
  remoteConfig?: BackgroundServiceRemoteConfig
  /** CLI approval switch state; omitted unless SCRY_EXPERIMENTAL_HOST_CLI=1 (P5-5b). */
  cliApproval?: HostCliApprovalSelfReport
  /** Authoritative orchestration status; omitted unless SCRY_ORCHESTRATION=on (P4-2 Decision H). */
  orchestration?: BackgroundServiceOrchestrationStatus
}

export type BackgroundServiceStatus =
  // Switch off: there is no background service; runs live in this App.
  | { mode: 'in-process'; userDataDir: string }
  | {
    mode: 'daemon'
    userDataDir: string
    connection: BackgroundServiceConnection
    version: string | null
    pid: number | null
    /** Epoch milliseconds; null when the daemon did not say. */
    startedAt: number | null
    devices: BackgroundServiceDevices | null
    activeRuns: number | null
    /** Who started the running daemon; null when unknown. */
    launchedBy?: BackgroundServiceLaunchedBy | null
    /** On Linux, true only when systemd MainPID matches the daemon's reported supervisor pid. */
    launchedByVerified?: boolean
    /** Effective remote policy reported by the running daemon; null when unknown. */
    remoteConfig?: BackgroundServiceRemoteConfig | null
    /** Login-start service state for this App and userDataDir (P5 §2.3). */
    loginStart?: LoginStartStatus
    /** Host CLI approval switch state; omitted unless SCRY_EXPERIMENTAL_HOST_CLI=1 (P5-5b). */
    cliApproval?: CliApprovalStatus
    /** Authoritative orchestration status; omitted unless SCRY_ORCHESTRATION=on (P4-2 Decision H). */
    orchestration?: BackgroundServiceOrchestrationStatus
    /** Non-silent warnings from service-launch fallback or adopted-daemon policy drift. */
    runtimeNotice?: BackgroundServiceRuntimeNotice
    /** When the App read this, so the section can say how fresh it is. */
    checkedAt: number
  }

export type BackgroundServiceAction = 'restart' | 'quit' | 'reconnect'

export type BackgroundServiceActionResult =
  | { status: 'done' }
  // The user declined the confirmation; nothing was signalled.
  | { status: 'cancelled' }
  // Nothing was done, or the action stopped where it failed; `reason` is a machine code
  // and `message` the readable sentence for it.
  | { status: 'failed'; reason: string; message: string }

const DAEMON_CREDENTIAL_UNAVAILABLE = 'daemon_credential_unavailable'

/** The App could not keep its local daemon grant (B4-S F2); any suffix is the cause code. */
export function isDaemonCredentialUnavailable(reason: string): boolean {
  return reason === DAEMON_CREDENTIAL_UNAVAILABLE || reason.startsWith(`${DAEMON_CREDENTIAL_UNAVAILABLE}:`)
}

/**
 * One sentence for that refusal, used by the error line, the «后台服务» section and its
 * action results alike. It says only what the App established: safeStorage refused (not
 * available, or Linux's plaintext `basic_text`). The Linux line names what the App needs,
 * not a diagnosis of which keyring is missing; other platforms get no advice that was
 * never checked there.
 */
export function daemonCredentialUnavailableMessage(reason: string, linux: boolean): string {
  const base = `系统密钥环不可用，Scry 无法保存本机后台服务的连接凭据，因此不能连接后台服务（${reason}）。`
  if (!linux) return base
  return `${base}Linux 上需要一个正在运行且已解锁的 Secret Service 密钥环（例如 gnome-keyring），然后重启 Scry。`
}
