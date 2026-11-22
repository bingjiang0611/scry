import type { BuildIdentity } from '../shared/build-identity'
import { isHostCliExperimentalEnabled } from '../shared/experimental-host-cli'
import type { BackgroundServiceLaunchedBy, BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import { pairingChannelHandlers, type PairingHost } from '../main/bootstrap/pairing-channels'
import { HASH, UUID } from '../main/remote/pairing-state'
import { computeEffectiveRemoteConfig } from './login-start/policy-env'
import type { HostAdminStore } from './host-admin-store'
import { mapHostAdminError, openHostAdminSocket, type HostAdminReply, type HostAdminSocket } from './host-admin-socket'


export interface DaemonHostAdminRuntimeDeps {
  daemonStateDirectory: string
  identity: BuildIdentity
  appVersion: string
  isPackaged: boolean
  hostAdmin: HostAdminStore
  remoteHost: () => PairingHost | null
  activeRuns: () => number
  orchestrationStatus?: () => BackgroundServiceOrchestrationStatus
  log: (line: string) => void
  env?: NodeJS.ProcessEnv
}

const READ_METHODS = new Set(['status', 'pending', 'devices'])
const TIGHTEN_METHODS = new Set(['cancel', 'revoke', 'desktop_off'])
const APPROVAL_METHODS = new Set(['invite_phone', 'invite_desktop', 'approve'])

function hasOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((k) => allowed.includes(k))
}

function sanitizeLogToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

function readLaunchedBy(env: NodeJS.ProcessEnv): BackgroundServiceLaunchedBy | undefined {
  const raw = env.SCRY_DAEMON_LAUNCHED_BY
  return raw === 'app' || raw === 'service' ? raw : undefined
}

function readSupervisorPid(env: NodeJS.ProcessEnv): number | undefined {
  const match = env.SCRY_DAEMON_STARTED_BY?.match(/^supervisor:(\d+)$/)
  if (!match) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

export async function attachDaemonHostAdmin(deps: DaemonHostAdminRuntimeDeps): Promise<HostAdminSocket | undefined> {
  const env = deps.env ?? process.env
  if (!isHostCliExperimentalEnabled(env)) return undefined

  const handlers = pairingChannelHandlers({ host: deps.remoteHost })

  const handle = async (method: string, args: Record<string, unknown>): Promise<HostAdminReply> => {
    const safeMethod = sanitizeLogToken(method)
    if (!READ_METHODS.has(method) && !TIGHTEN_METHODS.has(method) && !APPROVAL_METHODS.has(method)) {
      deps.log(`host-admin method=${safeMethod} result=unsupported_method`)
      return { ok: false, error: 'unsupported_method' }
    }

    if (APPROVAL_METHODS.has(method) && !deps.hostAdmin.isCliApprovalEnabled()) {
      deps.log(`host-admin method=${safeMethod} result=host_cli_approval_disabled`)
      return { ok: false, error: 'host_cli_approval_disabled' }
    }

    try {
      if (method === 'status') {
        if (!hasOnlyKeys(args, [])) return { ok: false, error: 'invalid_arguments' }
        const host = deps.remoteHost()
        const remote = handlers['remote:status']()
        const desktopAccess = handlers['remote:desktop:status']()
        const state = host?.authority.inspectLocal()
        const launchedBy = readLaunchedBy(env)
        const supervisorPid = readSupervisorPid(env)
        const result = {
          daemon: {
            version: deps.identity.version,
            ...(deps.identity.build ? { build: deps.identity.build } : {}),
            pid: process.pid,
            startedAt: Math.round(performance.timeOrigin),
            ...(launchedBy ? { launchedBy } : {}),
            ...(supervisorPid !== undefined ? { supervisorPid } : {})
          },
          activeRuns: deps.activeRuns(),
          remoteEnabled: remote.enabled,
          remote,
          remoteConfig: computeEffectiveRemoteConfig(env, deps.isPackaged),
          desktopAccess,
          cliApproval: deps.hostAdmin.snapshot(),
          ...(deps.orchestrationStatus ? { orchestration: deps.orchestrationStatus() } : {}),
          pairingCapacity: state
            ? { pairings: state.pairings.length, grants: state.grants.length, limit: 64 }
            : null
        }
        deps.log('host-admin method=status result=ok')
        return { ok: true, result }
      }

      if (method === 'pending') {
        if (!hasOnlyKeys(args, [])) return { ok: false, error: 'invalid_arguments' }
        const remote = handlers['remote:status']()
        const result = remote.enabled
          ? { enabled: true, pending: remote.pending }
          : { enabled: false, pending: [] }
        deps.log('host-admin method=pending result=ok')
        return { ok: true, result }
      }

      if (method === 'devices') {
        if (!hasOnlyKeys(args, [])) return { ok: false, error: 'invalid_arguments' }
        const remote = handlers['remote:status']()
        const result = remote.enabled
          ? { enabled: true, devices: remote.devices }
          : { enabled: false, devices: [] }
        deps.log('host-admin method=devices result=ok')
        return { ok: true, result }
      }

      if (method === 'invite_phone') {
        if (!hasOnlyKeys(args, [])) return { ok: false, error: 'invalid_arguments' }
        const rate = deps.hostAdmin.consumeRate('invite')
        if (!rate.allowed) {
          deps.log('host-admin method=invite_phone result=host_cli_rate_limited')
          return { ok: false, error: 'host_cli_rate_limited', retryAfterMs: rate.retryAfterMs, nextAllowedAt: rate.nextAllowedAt }
        }
        const code = await handlers['remote:pairing:begin']()
        deps.log(`host-admin method=invite_phone result=ok pairingId=${code.pairingId}`)
        return { ok: true, result: code }
      }

      if (method === 'invite_desktop') {
        if (!hasOnlyKeys(args, [])) return { ok: false, error: 'invalid_arguments' }
        const rate = deps.hostAdmin.consumeRate('invite')
        if (!rate.allowed) {
          deps.log('host-admin method=invite_desktop result=host_cli_rate_limited')
          return { ok: false, error: 'host_cli_rate_limited', retryAfterMs: rate.retryAfterMs, nextAllowedAt: rate.nextAllowedAt }
        }
        const invitation = await handlers['remote:desktop:invite']()
        deps.log('host-admin method=invite_desktop result=ok')
        return { ok: true, result: { invitation } }
      }

      if (method === 'approve') {
        if (!hasOnlyKeys(args, ['pairingId', 'publicKeySHA256'])) return { ok: false, error: 'invalid_arguments' }
        const { pairingId, publicKeySHA256 } = args
        if (typeof pairingId !== 'string' || !UUID.test(pairingId) || typeof publicKeySHA256 !== 'string' || !HASH.test(publicKeySHA256)) {
          deps.log('host-admin method=approve result=invalid_arguments')
          return { ok: false, error: 'invalid_arguments' }
        }
        const rate = deps.hostAdmin.consumeRate('approve')
        if (!rate.allowed) {
          deps.log(`host-admin method=approve result=host_cli_rate_limited pairingId=${pairingId}`)
          return { ok: false, error: 'host_cli_rate_limited', retryAfterMs: rate.retryAfterMs, nextAllowedAt: rate.nextAllowedAt }
        }
        const host = deps.remoteHost()
        if (!host) {
          deps.log(`host-admin method=approve result=remote_host_disabled pairingId=${pairingId}`)
          return { ok: false, error: 'remote_host_disabled' }
        }
        const device = await host.confirmPairing(pairingId, publicKeySHA256, { approvedVia: 'host_cli' })
        const fp16 = publicKeySHA256.slice(0, 16)
        deps.hostAdmin.recordNotice({
          kind: 'device_approved_via_cli',
          deviceId: device.deviceId,
          deviceLabel: device.deviceLabel,
          pairingId,
          fingerprintPrefix: fp16
        })
        deps.log(`host-admin method=approve result=ok pairingId=${pairingId} deviceId=${device.deviceId} fp=${fp16}`)
        return { ok: true, result: device }
      }

      if (method === 'cancel') {
        if (!hasOnlyKeys(args, ['pairingId'])) return { ok: false, error: 'invalid_arguments' }
        const { pairingId } = args
        if (typeof pairingId !== 'string' || !UUID.test(pairingId)) {
          deps.log('host-admin method=cancel result=invalid_arguments')
          return { ok: false, error: 'invalid_arguments' }
        }
        await handlers['remote:pairing:cancel'](pairingId)
        deps.hostAdmin.recordNotice({ kind: 'pairing_cancelled_via_cli', pairingId })
        deps.log(`host-admin method=cancel result=ok pairingId=${pairingId}`)
        return { ok: true, result: { cancelled: true, pairingId } }
      }

      if (method === 'revoke') {
        if (!hasOnlyKeys(args, ['deviceId'])) return { ok: false, error: 'invalid_arguments' }
        const { deviceId } = args
        if (typeof deviceId !== 'string' || !UUID.test(deviceId)) {
          deps.log('host-admin method=revoke result=invalid_arguments')
          return { ok: false, error: 'invalid_arguments' }
        }
        const host = deps.remoteHost()
        const existing = host?.authority.inspectLocal().grants.find((g) => g.deviceId === deviceId)
        await handlers['remote:device:revoke'](deviceId)
        deps.hostAdmin.recordNotice({
          kind: 'device_revoked_via_cli',
          deviceId,
          ...(existing?.deviceLabel ? { deviceLabel: existing.deviceLabel } : {}),
          ...(existing?.publicKeySHA256 ? { fingerprintPrefix: existing.publicKeySHA256.slice(0, 16) } : {})
        })
        deps.log(`host-admin method=revoke result=ok deviceId=${deviceId}`)
        return { ok: true, result: { revoked: true, deviceId } }
      }

      if (!hasOnlyKeys(args, [])) return { ok: false, error: 'invalid_arguments' }
      await handlers['remote:desktop:disable']()
      deps.hostAdmin.recordNotice({ kind: 'desktop_disabled_via_cli' })
      deps.log('host-admin method=desktop_off result=ok')
      return { ok: true, result: { disabled: true } }
    } catch (error) {
      const code = mapHostAdminError(error)
      deps.log(`host-admin method=${safeMethod} result=${code}`)
      return { ok: false, error: code }
    }
  }

  try {
    return await openHostAdminSocket({
      daemonStateDirectory: deps.daemonStateDirectory,
      daemonIdentity: deps.identity,
      handle
    })
  } catch (error) {
    deps.log(`host-admin.disabled reason=${mapHostAdminError(error)}`)
    return undefined
  }
}
