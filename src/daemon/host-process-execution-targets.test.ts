import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, tempDir } from './host-process.fixtures'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import type { ExecutionTargetRef } from '../shared/desktop-remote'
import { MAX_EXECUTION_TARGET_RESULT_BYTES } from './app-execution-target-bridge'
import { callTcp, openKeepAliveSocket } from './host-execution-targets-sockets.fixtures'

const TARGET: ExecutionTargetRef = {
  id: 'conn-mac2',
  binding: 'b'.repeat(64),
  hostId: 'mac2-host-id',
  label: 'Mac2',
  state: 'connected'
}

async function enrollLocalWithLabel(
  service: Awaited<ReturnType<typeof createDaemonHostProcess>>['service'],
  deviceLabel: string
) {
  const id = await generateDesktopDeviceIdentity()
  const grant = await service.enrollLocalDevice({ csrPEM: id.csrPEM, deviceLabel }, () => true)
  return { keyPEM: id.keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId }
}

async function pairRemotePhone(service: Awaited<ReturnType<typeof createDaemonHostProcess>>['service']) {
  const id = await generateDesktopDeviceIdentity()
  const { pairingId, secret } = await service.authority.begin()
  await service.authority.prove({ pairingId, secret, csrPEM: id.csrPEM, deviceLabel: 'iPhone W10' }, id.publicKeySHA256)
  const grant = await service.authority.confirmLocal(pairingId, id.publicKeySHA256)
  return { keyPEM: id.keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId, fingerprint: grant.certificateSHA256 }
}

describe('daemon execution target routing via App bridge', () => {
  afterEach(() => cleanupTempDirs())

  async function startDaemon(extra: { executionTargetCallTimeoutMs?: number } = {}) {
    const userDataDir = tempDir()
    const daemonStateDirectory = tempDir()
    const host = await createDaemonHostProcess({
      userDataDir,
      daemonStateDirectory,
      appPath: process.cwd(),
      resourcesPath: tempDir(),
      appVersion: '0.2.250',
      isPackaged: false,
      gatewayLabel: 'Mac1',
      createOutputStore: () => new MemoryOutputStore(),
      log: () => undefined,
      ...extra
    })
    const { port } = await host.service.host.listen(0, '127.0.0.1')
    return { host, port }
  }

  it('returns gateway-only discovery and execution_target_gateway_offline when App is not connected', async () => {
    const { host, port } = await startDaemon()
    try {
      const phone = await pairRemotePhone(host.service)
      const discovery = await callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, { op: 'executionTargets' })
      expect(discovery.error).toBeUndefined()
      expect(discovery.executionTargets).toEqual({
        version: 1,
        gateway: { hostId: host.service.hostId, label: 'Mac1' },
        targets: []
      })

      const targetReply = await callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'target',
        target: { id: TARGET.id, binding: TARGET.binding },
        request: { op: 'projects' }
      })
      expect(targetReply).toEqual({ error: 'execution_target_gateway_offline' })
    } finally {
      await host.dispose()
    }
  })

  it('forwards discovery and target requests through the primary App grant and stamps executionTarget', async () => {
    const { host, port } = await startDaemon()
    const app = await enrollLocalWithLabel(host.service, 'Scry App 0.2.250')
    const phone = await pairRemotePhone(host.service)
    const appPoll = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    const appReply = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    try {
      const work1Promise = appPoll.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const discoveryPromise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, { op: 'executionTargets' })

      const work1 = await work1Promise
      expect(work1.error).toBeUndefined()
      expect(work1.calls).toHaveLength(1)
      expect(work1.calls[0].method).toBe('executionTargets')
      const res1 = await appReply.request({
        op: 'executionTargetResult',
        callId: work1.calls[0].callId,
        ok: true,
        result: [TARGET]
      })
      expect(res1.accepted).toBe(true)

      await expect(discoveryPromise).resolves.toEqual({
        executionTargets: {
          version: 1,
          gateway: { hostId: host.service.hostId, label: 'Mac1' },
          targets: [TARGET]
        }
      })

      const work2Promise = appPoll.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const reqPromise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'target',
        target: { id: TARGET.id, binding: TARGET.binding },
        request: { op: 'projects' }
      })
      const work2 = await work2Promise
      expect(work2.calls[0].method).toBe('mobileRequest')
      expect(work2.calls[0].input).toEqual({ target: { id: TARGET.id, binding: TARGET.binding }, request: { op: 'projects' } })
      await appReply.request({
        op: 'executionTargetResult',
        callId: work2.calls[0].callId,
        ok: true,
        result: { projects: [{ path: '/mac2/repo', label: 'repo' }], executionTarget: { id: 'spoof', binding: 'c'.repeat(64) } }
      })
      await expect(reqPromise).resolves.toEqual({
        projects: [{ path: '/mac2/repo', label: 'repo' }],
        executionTarget: { id: TARGET.id, binding: TARGET.binding }
      })

      const intentId = '123e4567-e89b-42d3-a456-426614174000'
      const work3Promise = appPoll.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const submitPromise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'target',
        target: { id: TARGET.id, binding: TARGET.binding },
        request: { op: 'submit', intentId, detail: '{"cwd":"/mac2/repo","providerId":"codex"}' }
      })
      const work3 = await work3Promise
      expect(work3.calls[0].method).toBe('mobileSubmit')
      expect(work3.calls[0].input.phonePeerFingerprint).toBe(phone.fingerprint)
      expect(work3.calls[0].input.phoneIntentId).toBe(intentId)
      await appReply.request({
        op: 'executionTargetResult',
        callId: work3.calls[0].callId,
        ok: true,
        result: { runId: 'run-mac2', status: 'recorded' }
      })
      await expect(submitPromise).resolves.toEqual({
        runId: 'run-mac2',
        status: 'recorded',
        executionTarget: { id: TARGET.id, binding: TARGET.binding }
      })
    } finally {
      appPoll.destroy()
      appReply.destroy()
      await host.dispose()
    }
  })

  it('cancels a disconnected phone subscription at the App bridge and forwards the replacement snapshot', async () => {
    const { host, port } = await startDaemon()
    const ca = host.service.caCertificatePEM
    const app = await enrollLocalWithLabel(host.service, 'Scry App 0.2.250')
    const phone = await pairRemotePhone(host.service)
    const local = await openKeepAliveSocket(host.channel.socketPath, ca, app.certPEM, app.keyPEM)
    const first = await openKeepAliveSocket(port, ca, phone.certPEM, phone.keyPEM)
    const target = { id: TARGET.id, binding: TARGET.binding }
    const subscribe = (waitMs: number) => ({ op: 'target', target, request: {
      op: 'subscribe', views: ['sessions', 'activeRuns'], waitMs,
      ...(waitMs > 0 ? { known: { hostId: 'mac2-host-id', logId: 'history', seq: 1 } } : {})
    } })
    try {
      const work = local.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const orphan = first.request(subscribe(20_000)).catch(() => undefined)
      const [old] = (await work).calls
      expect(old.input.request).toMatchObject({ op: 'subscribe', waitMs: 20_000 })
      first.destroy()
      await orphan

      const cancellations = { calls: [], cancelledCallIds: [old.callId] }
      await expect(local.request({ op: 'executionTargetWork', waitMs: 1_000 })).resolves.toMatchObject(cancellations)
      await expect(local.request({ op: 'executionTargetWork', waitMs: 0 })).resolves.toMatchObject(cancellations)
      await expect(local.request({ op: 'executionTargetResult', callId: old.callId, ok: true, result: {} }))
        .resolves.toMatchObject({ accepted: false })

      const replacement = callTcp(port, ca, phone.certPEM, phone.keyPEM, subscribe(0))
      const { calls: [fresh] } = await local.request({
        op: 'executionTargetWork', waitMs: 5_000, ackCancelledCallIds: [old.callId]
      })
      expect(fresh).not.toMatchObject({ callId: old.callId })
      expect(fresh.input.request).toMatchObject({ op: 'subscribe', waitMs: 0, subscriptionId: old.input.request.subscriptionId })
      const result = { subscribe: { hostId: 'mac2-host-id', logId: 'history', seq: 2, mode: 'snapshot', snapshot: {} } }
      await expect(local.request({ op: 'executionTargetResult', callId: fresh.callId, ok: true, result }))
        .resolves.toMatchObject({ accepted: true })
      await expect(replacement).resolves.toEqual({ ...result, executionTarget: target })
    } finally {
      first.destroy()
      local.destroy()
      await host.dispose()
    }
  })

  it('rejects non-App local clients (e.g. scry CLI), refuses label spoofing, and hides local ops from network', async () => {
    const { host, port } = await startDaemon()
    const cli = await enrollLocalWithLabel(host.service, 'scry-cli')
    const phone = await pairRemotePhone(host.service)
    try {
      const cliPoll = await call(host.channel.socketPath, host.service.caCertificatePEM, cli.certPEM, cli.keyPEM, {
        op: 'executionTargetWork', waitMs: 0
      })
      expect(cliPoll).toEqual({ error: 'execution_target_bridge_unauthorized' })

      const cliRes = await call(host.channel.socketPath, host.service.caCertificatePEM, cli.certPEM, cli.keyPEM, {
        op: 'executionTargetResult', callId: 'call-1', ok: true, result: []
      })
      expect(cliRes).toEqual({ error: 'execution_target_bridge_unauthorized' })

      const spoofAttempt = await call(host.channel.socketPath, host.service.caCertificatePEM, cli.certPEM, cli.keyPEM, {
        op: 'projects', deviceLabel: 'Scry App 0.2.250'
      })
      expect(spoofAttempt).toEqual({ error: 'invalid_device_label' })
      const cliPollAfter = await call(host.channel.socketPath, host.service.caCertificatePEM, cli.certPEM, cli.keyPEM, {
        op: 'executionTargetWork', waitMs: 0
      })
      expect(cliPollAfter).toEqual({ error: 'execution_target_bridge_unauthorized' })

      const phoneNet = await callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'executionTargetWork', waitMs: 0
      })
      expect(phoneNet).toEqual({ error: 'unsupported_op' })
    } finally {
      await host.dispose()
    }
  })

  it('immediately fails in-flight forwarded calls when the App disconnects, and re-checks phone authorization', async () => {
    const { host, port } = await startDaemon({ executionTargetCallTimeoutMs: 10_000 })
    const app = await enrollLocalWithLabel(host.service, 'Scry App 0.2.250')
    const phone = await pairRemotePhone(host.service)
    const appPoll = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    try {
      const workPromise = appPoll.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const reqPromise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'target',
        target: { id: TARGET.id, binding: TARGET.binding },
        request: { op: 'projects' }
      })
      const work = await workPromise
      expect(work.calls).toHaveLength(1)

      const started = Date.now()
      appPoll.destroy()
      await expect(reqPromise).resolves.toEqual({ error: 'execution_target_gateway_offline' })
      expect(Date.now() - started).toBeLessThan(2_000)

      const appPoll2 = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
      const appReply2 = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
      try {
        const work2Promise = appPoll2.request({ op: 'executionTargetWork', waitMs: 5_000 })
        const req2Promise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
          op: 'target',
          target: { id: TARGET.id, binding: TARGET.binding },
          request: { op: 'projects' }
        })
        const work2 = await work2Promise
        await host.service.authority.revoke(phone.deviceId)
        await appReply2.request({
          op: 'executionTargetResult',
          callId: work2.calls[0].callId,
          ok: true,
          result: { projects: [] }
        })
        await expect(req2Promise).resolves.toEqual({ error: 'device_not_authorized' })
      } finally {
        appPoll2.destroy()
        appReply2.destroy()
      }
    } finally {
      await host.dispose()
    }
  })

  it('times out unanswered calls and enforces DEFAULT_MAX_FRAME on forwarded results', async () => {
    const { host, port } = await startDaemon({ executionTargetCallTimeoutMs: 120 })
    const app = await enrollLocalWithLabel(host.service, 'Scry App 0.2.250')
    const phone = await pairRemotePhone(host.service)
    const appPoll = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    const appReply = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    try {
      const work1Promise = appPoll.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const req1Promise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'target',
        target: { id: TARGET.id, binding: TARGET.binding },
        request: { op: 'projects' }
      })
      const work1 = await work1Promise
      expect(work1.calls).toHaveLength(1)
      await expect(req1Promise).resolves.toEqual({ error: 'execution_target_timeout' })

      const work2Promise = appPoll.request({ op: 'executionTargetWork', waitMs: 5_000 })
      const req2Promise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
        op: 'target',
        target: { id: TARGET.id, binding: TARGET.binding },
        request: { op: 'projects' }
      })
      const work2 = await work2Promise
      const overCap = 'x'.repeat(MAX_EXECUTION_TARGET_RESULT_BYTES + 16)
      const res2 = await appReply.request({
        op: 'executionTargetResult',
        callId: work2.calls[0].callId,
        ok: true,
        result: { blob: overCap }
      })
      expect(res2).toMatchObject({ error: 'execution_target_response_too_large' })
      await expect(req2Promise).resolves.toEqual({ error: 'execution_target_response_too_large' })
    } finally {
      appPoll.destroy()
      appReply.destroy()
      await host.dispose()
    }
  })

  it('returns gateway-only discovery on App disconnect mid-flight and cancels dead targetWork polls over local.sock', async () => {
    const { host, port } = await startDaemon({ executionTargetCallTimeoutMs: 10_000 })
    const app = await enrollLocalWithLabel(host.service, 'Scry App 0.2.250')
    const phone = await pairRemotePhone(host.service)
    const appPoll1 = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    const appReply = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
    try {
      const deadWork = appPoll1.request({ op: 'executionTargetWork', waitMs: 5_000 }).catch(() => 'closed')
      await new Promise((r) => setTimeout(r, 30))
      appPoll1.destroy()
      await deadWork

      const appPoll2 = await openKeepAliveSocket(host.channel.socketPath, host.service.caCertificatePEM, app.certPEM, app.keyPEM)
      try {
        const reqPromise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, {
          op: 'target',
          target: { id: TARGET.id, binding: TARGET.binding },
          request: { op: 'projects' }
        })
        const work2 = await appPoll2.request({ op: 'executionTargetWork', waitMs: 5_000 })
        expect(work2.calls).toHaveLength(1)
        await appReply.request({
          op: 'executionTargetResult',
          callId: work2.calls[0].callId,
          ok: true,
          result: { projects: [{ path: '/mac2/ok', label: 'ok' }] }
        })
        await expect(reqPromise).resolves.toEqual({
          projects: [{ path: '/mac2/ok', label: 'ok' }],
          executionTarget: { id: TARGET.id, binding: TARGET.binding }
        })

        const discWorkPromise = appPoll2.request({ op: 'executionTargetWork', waitMs: 5_000 })
        const discPromise = callTcp(port, host.service.caCertificatePEM, phone.certPEM, phone.keyPEM, { op: 'executionTargets' })
        const discWork = await discWorkPromise
        expect(discWork.calls).toHaveLength(1)
        appPoll2.destroy()
        appReply.destroy()
        await expect(discPromise).resolves.toEqual({
          executionTargets: {
            version: 1,
            gateway: { hostId: host.service.hostId, label: 'Mac1' },
            targets: []
          }
        })
      } finally {
        appPoll2.destroy()
      }
    } finally {
      appPoll1.destroy()
      appReply.destroy()
      await host.dispose()
    }
  })
})
