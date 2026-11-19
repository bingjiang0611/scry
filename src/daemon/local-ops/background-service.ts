import { pairingChannelHandlers } from '../../main/bootstrap/pairing-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { BackgroundServiceLaunchedBy, BackgroundServiceSelfReport } from '../../shared/background-service'
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

// What only the daemon knows for the «后台服务» section (B4-S S0-1, P5 §2.2): its own
// version, pid, start time, paired devices, unsettled runs, launcher and effective remote
// policy. Local endpoint only, like every local op. Devices are counted from the same
// remote:status main answers, which already leaves out the App's own local grant; remote
// access off is reported as such.
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
        remoteConfig: computeEffectiveRemoteConfig(process.env, deps.isPackaged)
      }
    }
  } as Record<string, LocalOpHandler>
}
