import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { ConversationStore } from '../main/conversation-store'
import { upsertTraceArchiveTurn } from '../main/transcript-archive'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, cleanupTempDirs, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setOnEnv() {
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

function seedDispatchedRun(sink: EventSink, runId: string, cwd: string, sessionKey: string | null = null): void {
  const now = Date.now() - 5_000
  const submitPayload = {
    runId,
    sessionKey,
    ...(sessionKey ? { ordinal: 1 } : {}),
    provider: 'codex',
    profile: null,
    cwd,
    claimMode: 'immediate' as const,
    leaseOwner: 'daemon:old',
    pendingTtlMs: 30_000
  }
  sink.execute({
    type: 'run.submit',
    commandId: `seed-submit:${runId}`,
    actor: 'system',
    scope: 'local',
    at: now,
    payload: submitPayload,
    payloadSha256: sha256Hex(canonicalJson(submitPayload))
  })
  const dispPayload = { runId, step: 'admitted_and_dispatched' as const }
  sink.execute({
    type: 'run.effect_result',
    commandId: `seed-disp:${runId}`,
    actor: `effect:seed-${runId}`,
    scope: 'system',
    at: now + 10,
    payload: dispPayload,
    payloadSha256: sha256Hex(canonicalJson(dispPayload))
  })
}

describe('W9 Blocker 3 + Blocker 4 + Must-Fix 10d: real recorder evidence recovery, two-ledger order, no fake orch:<runId>, event-first settle', () => {
  it('Blocker 3: real daemon recovery settles dispatched run with real committed trace archive evidence and interrupts run without evidence', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-b3')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const runWithArchive = randomUUID()
    const runWithoutEvidence = randomUUID()

    const seedSink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
    try {
      seedDispatchedRun(seedSink, runWithArchive, canonicalWs)
      seedDispatchedRun(seedSink, runWithoutEvidence, canonicalWs)
    } finally {
      seedSink.close()
    }

    upsertTraceArchiveTurn({
      userDataDir,
      cwd: canonicalWs,
      sessionId: 'native-codex-session-b3',
      providerId: 'codex',
      turn: {
        runId: runWithArchive,
        userText: 'hello',
        items: [],
        done: true,
        status: 'completed',
        completedAt: new Date().toISOString(),
        ts: Date.now()
      }
    })

    const restore = setOnEnv()
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

      expect(host.orchestrationAuthority!.recovery.settledFromEvidence).toBe(1)
      expect(host.orchestrationAuthority!.recovery.interruptedDispatched).toBe(1)
      expect(host.orchestrationAuthority!.sink.getRun(runWithArchive)?.lifecycle).toBe('settled')
      expect(host.orchestrationAuthority!.sink.getRun(runWithoutEvidence)?.lifecycle).toBe('interrupted')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 20_000)

  it('Blocker 4: real daemon reconciles pending conversation turns BEFORE generic recoverAll and never fabricates orch:<runId>', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-b4')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const convStore = new ConversationStore(userDataDir)
    const conv1 = await convStore.create(canonicalWs)
    const conv2 = await convStore.create(canonicalWs)
    const conv3 = await convStore.create(canonicalWs)

    const runAbsent = `run-${randomUUID()}`
    const runSettledNoBind = `run-${randomUUID()}`
    const runSettledWithBind = `run-${randomUUID()}`

    await convStore.begin(conv1.id, {
      commandId: `cmd-${randomUUID()}`,
      payloadHash: sha256Hex('conv1'),
      expectedRevision: conv1.revision,
      runId: runAbsent,
      target: { providerId: 'codex', continuationKey: 'codex-default' },
      items: [],
      selectedItems: []
    })
    await convStore.begin(conv2.id, {
      commandId: `cmd-${randomUUID()}`,
      payloadHash: sha256Hex('conv2'),
      expectedRevision: conv2.revision,
      runId: runSettledNoBind,
      target: { providerId: 'codex', continuationKey: 'codex-default' },
      items: [],
      selectedItems: []
    })
    await convStore.begin(conv3.id, {
      commandId: `cmd-${randomUUID()}`,
      payloadHash: sha256Hex('conv3'),
      expectedRevision: conv3.revision,
      runId: runSettledWithBind,
      target: { providerId: 'codex', continuationKey: 'codex-default' },
      items: [],
      selectedItems: []
    })

    const seedSink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
    try {
      const now = Date.now() - 4_000
      seedDispatchedRun(seedSink, runSettledNoBind, canonicalWs, conv2.id)
      const s2Payload = { runId: runSettledNoBind, step: 'settled' as const, settledAt: now, evidence: ['provider'] }
      seedSink.execute({
        type: 'run.effect_result',
        commandId: `seed-settle:${runSettledNoBind}`,
        actor: `effect:seed-${runSettledNoBind}`,
        scope: 'system',
        at: now,
        payload: s2Payload,
        payloadSha256: sha256Hex(canonicalJson(s2Payload))
      })

      seedDispatchedRun(seedSink, runSettledWithBind, canonicalWs, conv3.id)
      const bindPayload = { runId: runSettledWithBind, step: 'session_bound' as const, nativeSessionId: 'real-native-session-123' }
      seedSink.execute({
        type: 'run.effect_result',
        commandId: `seed-bind:${runSettledWithBind}`,
        actor: `effect:seed-${runSettledWithBind}`,
        scope: 'system',
        at: now,
        payload: bindPayload,
        payloadSha256: sha256Hex(canonicalJson(bindPayload))
      })
      const s3Payload = { runId: runSettledWithBind, step: 'settled' as const, settledAt: now + 5, evidence: ['provider'] }
      seedSink.execute({
        type: 'run.effect_result',
        commandId: `seed-settle:${runSettledWithBind}`,
        actor: `effect:seed-${runSettledWithBind}`,
        scope: 'system',
        at: now + 5,
        payload: s3Payload,
        payloadSha256: sha256Hex(canonicalJson(s3Payload))
      })
    } finally {
      seedSink.close()
    }

    const restore = setOnEnv()
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
      const after1 = await checkStore.required(conv1.id)
      const after2 = await checkStore.required(conv2.id)
      const after3 = await checkStore.required(conv3.id)

      const t1 = after1.turns[0]!
      const t2 = after2.turns[0]!
      const t3 = after3.turns[0]!
      expect(t1.origin).toBe('dispatch')
      expect(t2.origin).toBe('dispatch')
      expect(t3.origin).toBe('dispatch')
      if (t1.origin !== 'dispatch' || t2.origin !== 'dispatch' || t3.origin !== 'dispatch') return

      expect(t1.delivery).toEqual({
        status: 'not_sent',
        reason: 'orchestration_intent_absent'
      })

      expect(t2.delivery.status).toBe('unknown')
      expect(after2.bindings.some((b) => b.nativeSessionId?.startsWith('orch:'))).toBe(false)

      expect(t3.delivery.status).toBe('accepted')
      expect(after3.bindings.some((b) => b.nativeSessionId === 'real-native-session-123')).toBe(true)
    } finally {
      await host?.dispose()
      restore()
    }
  }, 20_000)

  it('Must-Fix 10d (Decision G): commits turn.delivery event in orchestration.db BEFORE conversation file persist', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const workspace = join(root, 'ws-10d')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)

    const sink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
    const convStore = new ConversationStore(userDataDir)
    let eventCommittedBeforePersist: boolean | undefined
    try {
      const conv = await convStore.create(canonicalWs)
      const runId = `run-${randomUUID()}`
      await convStore.begin(conv.id, {
        commandId: `cmd-${randomUUID()}`,
        payloadHash: sha256Hex('10d'),
        expectedRevision: conv.revision,
        runId,
        target: { providerId: 'codex', continuationKey: 'codex-default' },
        items: [],
        selectedItems: []
      })
      seedDispatchedRun(sink, runId, canonicalWs, conv.id)

      // Attach Decision G before-settle observer (same contract orchestration-authority uses)
      const beforeSetter = (convStore as unknown as {
        setBeforeTurnSettledObserver?: (fn: (info: {
          conversationId: string
          runId: string
          ordinal: number
          delivery: { status: 'accepted' | 'not_sent' | 'unknown'; reason?: string }
        }) => void) => void
      }).setBeforeTurnSettledObserver
      expect(typeof beforeSetter).toBe('function')
      beforeSetter!.call(convStore, (info) => {
        const at = Date.now()
        const payload = {
          sessionKey: info.conversationId,
          runId: info.runId,
          ordinal: info.ordinal,
          delivery: info.delivery.status,
          settledAt: at,
          evidence: [`conversation:${info.conversationId}`]
        }
        sink.execute({
          type: 'turn.record_delivery',
          commandId: `effect:p4-conv-${info.conversationId}-${info.runId}:${info.delivery.status}`,
          actor: `effect:p4-conv-${info.conversationId}`,
          scope: 'system',
          at,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        })
      })

      const origPersist = convStore.persist.bind(convStore)
      convStore.persist = async (conversation, exclusive) => {
        eventCommittedBeforePersist = sink
          .listEvents()
          .some((e) => e.runId === runId && e.type === 'turn.delivery')
        return origPersist(conversation, exclusive)
      }

      await convStore.settle(
        conv.id,
        runId,
        { status: 'accepted', nativeSessionId: 'native-10d', outcome: 'completed', nativeItems: [] },
        []
      )
      expect(eventCommittedBeforePersist).toBe(true)
    } finally {
      sink.close()
    }
  })
})
