import type { BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import type { BuildIdentity } from '../shared/build-identity'
import type { HostAdminStore } from './host-admin-store'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import { attachDaemonHostAdmin } from './host-admin-runtime'
import { localEnrollHandlers, openLocalEnrollSocket, openLocalEnrollmentStore } from './local-enrollment'
import { openLocalChannel } from './local-channel'
import { remoteHostEnabled } from '../main/remote/remote-defaults'

/**
 * The App's own endpoints: the local channel, the single-use enrollment socket and the admin socket.
 * They share one identity and one active-run count, so they are wired together here instead of inside
 * the daemon entry, which only needs to dispose them.
 */
export async function attachDaemonEndpoints(input: {
  daemonStateDirectory: string
  appVersion: string
  isPackaged: boolean
  identity: BuildIdentity
  service: RemoteHostService
  targetBridge: { onPeerDisconnected: (fingerprint: string) => void }
  activeRuns: () => number
  hostAdmin: HostAdminStore
  remoteHostService: () => RemoteHostService | null
  orchestrationStatus: () => BackgroundServiceOrchestrationStatus
  log: (line: string) => void
}): Promise<{
  channel: Awaited<ReturnType<typeof openLocalChannel>>
  enrollSocket: Awaited<ReturnType<typeof openLocalEnrollSocket>>
  adminSocket: Awaited<ReturnType<typeof attachDaemonHostAdmin>>
  localHost: ReturnType<RemoteHostService['createLocalHost']>
}> {
  const localHost = input.service.createLocalHost(input.identity, {
    onPeerDisconnected: (fingerprint) => input.targetBridge.onPeerDisconnected(fingerprint),
    activeRuns: input.activeRuns,
    isPackaged: input.isPackaged,
    subscribe: 1
  })
  const channel = await openLocalChannel({
    directory: input.daemonStateDirectory,
    serve: (stream) => localHost.serve(stream)
  })
  // Enrollment bootstraps the App's grant before it owns any certificate. The secret
  // exists only while no local grant is live and is consumed by a single enrollment.
  const enrollment = openLocalEnrollmentStore(input.daemonStateDirectory)
  enrollment.ensure(input.service.hasActiveLocalGrant())
  const enrollSocket = await openLocalEnrollSocket({
    directory: input.daemonStateDirectory,
    enroll: localEnrollHandlers(enrollment, {
      enrollLocal: (actor, consumeSecret) => input.service.enrollLocalDevice(actor, consumeSecret)
    }, input.service.caCertificatePEM, input.identity)
  })
  const adminSocket = await attachDaemonHostAdmin({
    daemonStateDirectory: input.daemonStateDirectory,
    identity: input.identity,
    appVersion: input.appVersion,
    isPackaged: input.isPackaged,
    hostAdmin: input.hostAdmin,
    remoteHost: () => remoteHostEnabled(process.env.SCRY_REMOTE_HOST, input.isPackaged) ? input.remoteHostService() : null,
    activeRuns: input.activeRuns,
    orchestrationStatus: input.orchestrationStatus,
    log: input.log
  })
  input.log(`daemon.host-ready socket=${channel.socketPath} enroll=${enrollSocket.socketPath}${adminSocket ? ` admin=${adminSocket.socketPath}` : ''}`)
  return { channel, enrollSocket, adminSocket, localHost }
}
