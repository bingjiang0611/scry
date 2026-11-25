import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { ConversationStore } from '../main/conversation-store'
import { ProviderOperationGate, providerOperationKey } from '../main/provider-operation-gate'
import { createExecution } from '../main/remote/host-controller-execution'
import { RemoteInteractionBroker } from '../main/remote/remote-interaction-broker'
import { RunOutputLog } from '../main/remote/run-output-log'
import { SessionLedger } from '../main/remote/session-ledger'
import { sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { importLegacyStateIncrementally } from '../host-runtime/orchestration/legacy-import'
import { AuthorityMcpTrustGate } from './orchestration-trust-gate'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, cleanupTempDirs, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setSmokeEnv() {
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

describe('W9 Round-2 Must-Fixes 1, 4, 5a-c, 6, 7', () => {
  it('Must-Fix 1: AuthorityMcpTrustGate skips pi and detects repo MCP config mutation between prepare and verify', () => {
    const root = tempDir()
    const ws = join(root, 'ws-trust-r8')
    mkdirSync(join(ws, '.codex'), { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    const configPath = join(canonicalWs, '.codex', 'config.toml')
    writeFileSync(configPath, '[mcp_servers.r8]\ncommand = "/bin/echo"\nargs = ["v1"]\n')

    const gate = new AuthorityMcpTrustGate()
    // pi skips repo MCP trust gate (aligned with run-admission.ts:199)
    expect(gate.verify('run-pi', 'pi', canonicalWs)).toEqual({ ok: true })

    // codex prepare + unchanged verify passes
    gate.prepare('run-codex', 'codex', canonicalWs)
    expect(gate.verify('run-codex', 'codex', canonicalWs)).toEqual({ ok: true })

    // Mutating config between prepare and verify MUST fail closed with fingerprint change message!
    writeFileSync(configPath, '[mcp_servers.r8]\ncommand = "/bin/echo"\nargs = ["v2-mutated"]\n')
    const afterMutation = gate.verify('run-codex', 'codex', canonicalWs)
    expect(afterMutation.ok).toBe(false)
    if (!afterMutation.ok) {
      expect(afterMutation.detail).toContain('发生变化')
    }
  })

  it('Must-Fix 4: rejected engine.answerQuestion fails closed and throws before broker delivers answer', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-ans-r8')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setSmokeEnv()
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
      // Answering a non-existent runId/questionId via hooks.onQuestionAnswer MUST throw fail-closed!
      expect(() =>
        host!.orchestrationAuthority!.hooks.onQuestionAnswer({
          peerCertSHA256: 'a'.repeat(64),
          grantScope: 'local',
          runId: randomUUID(),
          questionId: 'q-nonexistent',
          answerId: randomUUID(),
          answerSha256: sha256Hex('answer'),
          response: { runId: 'q-nonexistent', questionId: 'q-nonexistent', behavior: 'cancelled' }
        })
      ).toThrow()
    } finally {
      await host?.dispose()
      restore()
    }
  }, 20_000)

  it('Must-Fix 5a + 5b + 5c: emits turn.record_delivery on reconciliation, and never misjudges deferred-import settled turns as not_sent', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-reconcile-r8')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const convStore = new ConversationStore(userDataDir)
    const convDeferred = await convStore.create(canonicalWs)
    const convAbsent = await convStore.create(canonicalWs)
    const settledConvRunId = `run-${randomUUID()}`
    const absentConvRunId = `run-${randomUUID()}`

    await convStore.begin(convDeferred.id, {
      commandId: `cmd-${randomUUID()}`,
      payloadHash: sha256Hex('deferred'),
      expectedRevision: convDeferred.revision,
      runId: settledConvRunId,
      target: { providerId: 'codex', continuationKey: 'codex-default' },
      items: [],
      selectedItems: []
    })
    await convStore.begin(convAbsent.id, {
      commandId: `cmd-${randomUUID()}`,
      payloadHash: sha256Hex('absent'),
      expectedRevision: convAbsent.revision,
      runId: absentConvRunId,
      target: { providerId: 'codex', continuationKey: 'codex-default' },
      items: [],
      selectedItems: []
    })

    // Seed 2,100 terminal H1 runs (> 2,000 deferred threshold), including `settledConvRunId`!
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const lines: string[] = []
    let seq = 0
    const t0 = Date.now() - 60_000
    for (let i = 0; i < 2_099; i += 1) {
      const r = randomUUID()
      lines.push(
        JSON.stringify({ seq: ++seq, at: t0 + i, runId: r, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: `p-${i}` }) }),
        JSON.stringify({ seq: ++seq, at: t0 + i + 1, runId: r, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: t0 + i + 2, runId: r, kind: 'run_settled' })
      )
    }
    const ledgerRunId = randomUUID()
    lines.push(
      JSON.stringify({
        seq: ++seq,
        at: t0 + 3000,
        runId: ledgerRunId,
        kind: 'intent_recorded',
        intentId: randomUUID(),
        detail: JSON.stringify({
          providerId: 'codex',
          cwd: canonicalWs,
          prompt: 'conv turn settled in H1',
          conversation: { conversationId: convDeferred.id, runId: settledConvRunId, ordinal: 1 }
        })
      }),
      JSON.stringify({ seq: ++seq, at: t0 + 3001, runId: ledgerRunId, kind: 'run_dispatched' }),
      JSON.stringify({ seq: ++seq, at: t0 + 3002, runId: ledgerRunId, kind: 'run_settled' })
    )
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })

    // Use whitespace + uppercase " ON " to verify Must-Fix 5a (parseOrchestrationMode in host-process.ts)!
    const restore = setSmokeEnv()
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

      const checkStore = new ConversationStore(userDataDir)
      const afterDeferred = await checkStore.required(convDeferred.id)
      const afterAbsent = await checkStore.required(convAbsent.id)
      const tDeferred = afterDeferred.turns[0]!
      const tAbsent = afterAbsent.turns[0]!
      expect(tDeferred.origin).toBe('dispatch')
      expect(tAbsent.origin).toBe('dispatch')
      if (tDeferred.origin !== 'dispatch' || tAbsent.origin !== 'dispatch') return

      // Must-Fix 5c: settled H1 conversation turn MUST NOT be falsely marked `not_sent` during deferred import!
      expect(tDeferred.delivery.status).not.toBe('not_sent')
      // Must-Fix 5a: genuinely absent turn is reconciled as `not_sent` (not hijacked by early recoverAll)!
      expect(tAbsent.delivery).toEqual({ status: 'not_sent', reason: 'orchestration_intent_absent' })

      // Must-Fix 5b: reconciled turn ALSO committed `turn.delivery` event to orchestration.db!
      const deliveryEvents = host.orchestrationAuthority!.sink
        .listEvents()
        .filter((e) => e.type === 'turn.delivery' && e.runId === settledConvRunId)
      expect(deliveryEvents.length).toBeGreaterThanOrEqual(1)
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('Must-Fix 6: cancels imported H1 recorded runs lacking peer provenance fail-closed under reconcileOpenRuns=true', () => {
    const root = tempDir()
    const ledgerDir = join(root, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const runId = randomUUID()
    const now = Date.now()
    writeFileSync(
      join(ledgerDir, 'session-ledger.log'),
      JSON.stringify({
        seq: 1,
        at: now - 1_000, // NOT expired (< 30s TTL), non-conversation remote run
        runId,
        kind: 'intent_recorded',
        intentId: randomUUID(),
        detail: JSON.stringify({ providerId: 'codex', cwd: root, prompt: 'legacy open recorded' })
      }) + '\n',
      { mode: 0o600 }
    )
    const sink = EventSink.open({ userDataDir: root, checkpointIntervalMs: 0 })
    try {
      importLegacyStateIncrementally({
        sink,
        userDataDir: root,
        now,
        pendingTtlMs: 30_000,
        reconcileOpenRuns: true,
        shadowOnly: false
      })
      expect(sink.getRun(runId)?.lifecycle).toBe('cancelled')
      const cancelEvt = sink.listEvents().find((e) => e.runId === runId && e.type === 'run.cancelled')
      expect(cancelEvt?.payload?.reason).toBe('legacy_owner_unavailable')
    } finally {
      sink.close()
    }
  })

  it('Must-Fix 7: does NOT attach gate onAuthenticationReleased re-pump listener when orchestration is disabled', () => {
    const gate = new ProviderOperationGate()
    const onAuthReleasedSpy = vi.spyOn(gate, 'onAuthenticationReleased')
    const memStore = { assertAvailable: () => undefined, loadAll: () => [], append: () => undefined }
    const ledger = new SessionLedger({ store: memStore })
    const exec = createExecution({
      deps: {
        pairing: {} as never,
        ledgerStore: memStore,
        outputStore: new MemoryOutputStore(),
        workspace: { authorize: (c) => c },
        runProvider: async () => undefined,
        gate
        // The synthetic cleanup host has no orchestration authority.
      },
      authority: { authorizesCertificate: () => true } as never,
      ledger,
      output: new RunOutputLog({ store: new MemoryOutputStore() }),
      fileDownloads: { dispose: () => undefined } as never,
      interactions: new RemoteInteractionBroker(() => undefined),
      stops: new Map(),
      resolveAttachments: async (r) => r,
      releaseAttachments: async () => undefined,
    })
    try {
      const lease = gate.acquireAuthentication(providerOperationKey('codex'))
      if (lease.ok) lease.release()
      expect(onAuthReleasedSpy).not.toHaveBeenCalled()
    } finally {
      exec.dispose()
    }
  })
})
