import { pairingChannelHandlers } from '../../main/bootstrap/pairing-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { BackgroundServiceLaunchedBy, BackgroundServiceSelfReport } from '../../shared/background-service'
import { isHostCliExperimentalEnabled } from '../../shared/experimental-host-cli'
import { computeEffectiveRemoteConfig } from '../login-start/policy-env'
import type { DaemonLocalOpGroup } from './deps'

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

export const backgroundServiceLocalOps: DaemonLocalOpGroup = (deps) => {
  const remoteStatus = pairingChannelHandlers({ host: deps.remoteHost })['remote:status']
  return {
    'remote:backgroundService:status': (...args: unknown[]): BackgroundServiceSelfReport => {
      if (args.length > 0) throw new Error('invalid_request')
      const remote = remoteStatus()
      const now = Date.now()
      const launchedBy = readLaunchedBy(process.env)
      const supervisorPid = readSupervisorPid(process.env)
      return {
        version: deps.appVersion,
        pid: process.pid,
        startedAt: Math.round(performance.timeOrigin),
        devices: remote.enabled
          ? { state: 'known', paired: remote.devices.filter((device) => !device.revoked && device.expiresAt > now).length }
          : { state: 'remote-disabled' },
        activeRuns: deps.runs().unsettledStates().length,
        ...(launchedBy ? { launchedBy } : {}),
        ...(supervisorPid !== undefined ? { supervisorPid } : {}),
        remoteConfig: computeEffectiveRemoteConfig(process.env, deps.isPackaged),
        ...(isHostCliExperimentalEnabled(process.env) && deps.hostAdmin
          ? { cliApproval: deps.hostAdmin.snapshot() }
          : {}),
        ...(deps.orchestrationStatus ? { orchestration: deps.orchestrationStatus() } : {})
      }
    },
    'remote:hostAdmin:setCliApproval': (...args: unknown[]) => {
      if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('invalid_request')
      if (!isHostCliExperimentalEnabled(process.env)) throw new Error('host_cli_experimental_disabled')
      if (!deps.hostAdmin) throw new Error('host_admin_unavailable')
      const state = deps.hostAdmin.setCliApprovalEnabled(args[0])
      deps.log?.(`host-admin method=setCliApproval result=ok enabled=${state.enabled}`)
      return state
    }
  } as Record<string, LocalOpHandler>
}
