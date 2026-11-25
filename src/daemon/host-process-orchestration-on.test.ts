import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { INLINE_BODY_MAX_BYTES } from '../host-runtime/orchestration/types'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitRunTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)


function saveEnv() {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
  }
}

describe('P4-2 daemon authoritative orchestration integration', () => {
  it('runs send, >16 KiB durable body, resolveIntent tombstone, replay parity', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-p4-2')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restoreEnv = saveEnv()
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

      expect(host.orchestrationAuthority).toBeDefined()
      const authority = host.orchestrationAuthority!

      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM
      const cert = device.certPEM
      const key = device.keyPEM

      const largePrompt = 'P4-2 large prompt ' + 'L'.repeat(INLINE_BODY_MAX_BYTES + 2048)
      const intentId1 = randomUUID()
      const submitted = await call(host.channel.socketPath, ca, cert, key, {
        op: 'submit',
        intentId: intentId1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: largePrompt })
      })
      const runId1 = submitted.runId as string
      expect(runId1).toBeTruthy()
      const finalState = await waitRunTerminal(host.channel.socketPath, ca, cert, key, runId1)
      expect(finalState).toBe('settled')

      const runRow = authority.sink.getRun(runId1)
      expect(runRow?.lifecycle).toBe('settled')
      expect(runRow?.body?.storage).toBe('external')
      expect(authority.sink.bodyStore.hasExternalBody(runRow!.body!.sha256)).toBe(true)

      const dup = await call(host.channel.socketPath, ca, cert, key, {
        op: 'submit',
        intentId: intentId1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: largePrompt })
      })
      expect(dup.runId).toBe(runId1)
      expect(dup.status).toBe('duplicate')

      const absentIntent = randomUUID()
      const resolved = await call(host.channel.socketPath, ca, cert, key, {
        op: 'resolveIntent',
        intentId: absentIntent
      })
      expect(resolved.intent?.state).toBe('cancelled')

      const lateSubmit = await call(host.channel.socketPath, ca, cert, key, {
        op: 'submit',
        intentId: absentIntent,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'late after resolve' })
      })
      expect(lateSubmit.error).toBe('command_payload_conflict')

      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })

    } finally {
      await host?.dispose()
      restoreEnv()
    }
  })

  it('recovers dispatched run as interrupted (settled_at=null) and closes open question in same tx across daemon restart', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-restart')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const orphanRunId = randomUUID()
    const seedSink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
    try {
      const submitPayload = {
        runId: orphanRunId,
        sessionKey: null,
        provider: 'codex',
        profile: null,
        cwd: canonicalWs,
        claimMode: 'immediate' as const,
        origin: 'remote' as const
      }
      seedSink.execute({
        type: 'run.submit',
        commandId: randomUUID(),
        actor: 'system',
        scope: 'remote',
        at: Date.now() - 10_000,
        payload: submitPayload,
        payloadSha256: sha256Hex(canonicalJson(submitPayload))
      })
      seedSink.execute({
        type: 'run.effect_result',
        commandId: `eff-${orphanRunId}-disp`,
        actor: `effect:${orphanRunId}`,
        scope: 'system',
        at: Date.now() - 9_900,
        payload: { runId: orphanRunId, step: 'admitted_and_dispatched' },
        payloadSha256: sha256Hex(canonicalJson({ runId: orphanRunId, step: 'admitted_and_dispatched' }))
      })
      seedSink.execute({
        type: 'run.effect_result',
        commandId: `eff-${orphanRunId}-q`,
        actor: `effect:${orphanRunId}`,
        scope: 'system',
        at: Date.now() - 9_800,
        payload: { runId: orphanRunId, step: 'question_opened', questionId: 'q-restart-1' },
        payloadSha256: sha256Hex(
          canonicalJson({ runId: orphanRunId, step: 'question_opened', questionId: 'q-restart-1' })
        )
      })
    } finally {
      seedSink.close()
    }

    const restoreEnv = saveEnv()
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

      const authority = host.orchestrationAuthority!
      const recovered = authority.sink.getRun(orphanRunId)
      expect(recovered?.lifecycle).toBe('interrupted')
      expect(recovered?.settledAt).toBeNull()
      expect(recovered?.recoveredAt).not.toBeNull()
      expect(authority.sink.getInteraction(orphanRunId, 'q-restart-1')?.state).toBe('closed')
      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
    } finally {
      await host?.dispose()
      restoreEnv()
    }
  })
})
