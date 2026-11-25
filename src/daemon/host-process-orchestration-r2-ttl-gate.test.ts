import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { providerOperationKey } from '../main/provider-operation-gate'
import { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setOnEnv(pendingTtlMs?: number) {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    ttl: process.env.SCRY_ORCHESTRATION_PENDING_TTL_MS,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  if (pendingTtlMs !== undefined) process.env.SCRY_ORCHESTRATION_PENDING_TTL_MS = String(pendingTtlMs)
  else delete process.env.SCRY_ORCHESTRATION_PENDING_TTL_MS
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
    if (saved.ttl === undefined) delete process.env.SCRY_ORCHESTRATION_PENDING_TTL_MS
    else process.env.SCRY_ORCHESTRATION_PENDING_TTL_MS = saved.ttl
  }
}

const waitRunTerminal = (socketPath: string, ca: string, cert: string, key: string, runId: string) =>
  waitForProjectedRun(socketPath, ca, cert, key, runId, 500)

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('W9 Blocker 2 + Must-Fix 2: pending TTL, gate release re-pump, and persisted ownerActor recheck', () => {
  it('requeues while auth gate is held and auto-dispatches + settles when auth gate releases', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-gate')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setOnEnv(10_000)
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const device = await enrollLocal(host.service)
      const authLease = host.providerOperationGate.acquireAuthentication(providerOperationKey('codex'))
      expect(authLease.ok).toBe(true)

      const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'queued behind auth' })
      })

      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(host.orchestrationAuthority!.sink.getRun(sub.runId)?.lifecycle).toBe('recorded')
      expect(host.orchestrationAuthority!.sink.listEvents().some((e) => e.runId === sub.runId && e.type === 'run.dispatched')).toBe(false)

      if (authLease.ok) authLease.release()

      const finalState = await waitRunTerminal(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        sub.runId
      )
      expect(finalState).toBe('settled')
      expect(host.orchestrationAuthority!.sink.getRun(sub.runId)?.lifecycle).toBe('settled')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 20_000)

  it('expires pending runs past TTL as cancelled(pending_expired) with 0 Provider calls and frees the session slot', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-ttl')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setOnEnv(150)
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const device = await enrollLocal(host.service)
      const authLease = host.providerOperationGate.acquireAuthentication(providerOperationKey('codex'))
      expect(authLease.ok).toBe(true)

      const sub1 = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'will expire while queued' })
      })

      const expired = await waitUntil(
        () => host!.orchestrationAuthority!.sink.getRun(sub1.runId)?.lifecycle === 'cancelled',
        3_000
      )
      expect(expired).toBe(true)
      const expiredRun = host.orchestrationAuthority!.sink.getRun(sub1.runId)
      expect(expiredRun?.lifecycle).toBe('cancelled')
      const cancelEvt = host.orchestrationAuthority!.sink.listEvents().find((e) => e.runId === sub1.runId && e.type === 'run.cancelled')
      expect(cancelEvt?.payload?.reason).toBe('pending_expired')
      expect(host.orchestrationAuthority!.sink.listEvents().some((e) => e.runId === sub1.runId && e.type === 'run.dispatched')).toBe(false)

      if (authLease.ok) authLease.release()
      const sub2 = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'succeeds after expiry' })
      })
      const final2 = await waitRunTerminal(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        sub2.runId
      )
      expect(final2).toBe('settled')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 20_000)

  it('checks persisted run.ownerActor after daemon restart and rejects revoked peer with 0 Provider calls (Must-Fix 2)', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-revoked')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setOnEnv(30_000)
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host1 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const device = await enrollLocal(host1.service)
      const grant = host1.service.authority.inspectLocal().grants[0]!

      const authLease = host1.providerOperationGate.acquireAuthentication(providerOperationKey('codex'))
      expect(authLease.ok).toBe(true)

      const sub = await call(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'submitted then peer revoked' })
      })
      expect(host1.orchestrationAuthority!.sink.getRun(sub.runId)?.lifecycle).toBe('recorded')
      expect(host1.orchestrationAuthority!.sink.getRun(sub.runId)?.ownerActor).toBe(`peer:${grant.certificateSHA256}`)

      host1.service.revokeDevice(grant.deviceId)
      await host1.dispose()
      host1 = undefined

      host2 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const rejected = await waitUntil(
        () => host2!.orchestrationAuthority!.sink.getRun(sub.runId)?.lifecycle !== 'recorded',
        3_000
      )
      expect(rejected).toBe(true)
      const finalRun = host2.orchestrationAuthority!.sink.getRun(sub.runId)
      expect(finalRun?.lifecycle).toBe('failed')
      const failEvt = host2.orchestrationAuthority!.sink.listEvents().find((e) => e.runId === sub.runId && e.type === 'run.failed')
      expect(failEvt?.payload?.reason).toBe('grant_revoked')
      expect(host2.orchestrationAuthority!.sink.listEvents().some((e) => e.runId === sub.runId && e.type === 'run.dispatched')).toBe(false)
    } finally {
      await host1?.dispose()
      await host2?.dispose()
      restore()
    }
  }, 20_000)

  it('treats clock rollback before intentAt as pending_expired before dispatch', () => {
    const root = tempDir()
    const sink = EventSink.open({ userDataDir: root, checkpointIntervalMs: 0 })
    let now = 10_000
    try {
      const engine = new AuthorityEngine({ sink, pendingTtlMs: 30_000, clock: () => now })
      const sub = engine.submitSync({
        grantScope: 'local',
        commandId: 'rollback-cmd',
        detail: JSON.stringify({ cwd: root, providerId: 'codex', prompt: 'hi' })
      })
      expect(sub.kind).toBe('accepted')
      if (sub.kind !== 'accepted') return
      now = 5_000
      const check = engine.beforeDispatch({
        runId: sub.runId,
        cwd: root,
        provider: 'codex',
        profile: null,
        actor: 'system',
        authorizeWorkspace: (c) => c,
        isPeerAuthorized: () => true,
        isProviderAuthenticating: () => false
      })
      expect(check).toEqual({ ok: false, action: 'fail', reason: 'pending_expired' })
      expect(sink.getRun(sub.runId)?.lifecycle).toBe('cancelled')
      const cancelEvt = sink.listEvents().find((e) => e.runId === sub.runId && e.type === 'run.cancelled')
      expect(cancelEvt?.payload?.reason).toBe('pending_expired')
    } finally {
      sink.close()
    }
  })
})
